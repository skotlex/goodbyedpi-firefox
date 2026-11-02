// GoodbyeDPI for Firefox 도우미 — 설치 프로그램과 네이티브 메시징 호스트를 겸하는 단일 실행 파일.
//   더블클릭(인수 없음)  : %LOCALAPPDATA%\GoodbyeDPIFirefox 에 설치하고 Firefox 에 호스트를 등록한다
//   --uninstall          : 프로세스·레지스트리·파일을 제거한다
//   Firefox 가 실행      : 인수로 manifest 경로와 확장 ID 를 받아 메시지 하나를 처리하고 종료한다
// ciadpi.exe 와 라이선스는 이 파일의 리소스로 내장되어 있다.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

[assembly: AssemblyTitle("GoodbyeDPI for Firefox Helper")]
[assembly: AssemblyProduct("GoodbyeDPI for Firefox")]

static class Program
{
    const string HostName = "com.goodbyedpi.firefox";
    const string ExtensionId = "goodbyedpi-firefox@skotlex";
    const string ProductName = "GoodbyeDPI for Firefox";
    // 확장의 HOST_PROTOCOL 과 짝을 이룬다. 메시지 규격이 바뀌면 함께 올린다.
    const int Protocol = 1;

    const string NativeHostsKey = @"SOFTWARE\Mozilla\NativeMessagingHosts";
    const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\GoodbyeDPIFirefox";

    static readonly string InstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GoodbyeDPIFirefox");
    static readonly string HostExe = Path.Combine(InstallDir, "goodbyedpi-host.exe");
    static readonly string BackendExe = Path.Combine(InstallDir, "ciadpi.exe");
    static readonly string StateFile = Path.Combine(InstallDir, "state.json");

    static int Main(string[] args)
    {
        bool silent = args.Contains("--silent");
        string first = args.Length > 0 ? args[0] : "";
        try
        {
            if (first.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || args.Contains(ExtensionId))
            {
                RunNativeHost();
                return 0;
            }
            if (first == "--uninstall")
            {
                Uninstall();
                if (!silent) Notify("제거했습니다.", 0x40);
                return 0;
            }
            Install();
            if (!silent) Notify("설치했습니다. Firefox 로 돌아가 토글을 켜세요.", 0x40);
            return 0;
        }
        catch (Exception e)
        {
            if (!silent) Notify("실패했습니다.\n\n" + e.Message, 0x10);
            return 1;
        }
    }

    // ---- 설치 / 제거 ---------------------------------------------------------

    static void Install()
    {
        Directory.CreateDirectory(InstallDir);
        StopBackend();
        string self = Assembly.GetExecutingAssembly().Location;
        if (!string.Equals(self, HostExe, StringComparison.OrdinalIgnoreCase))
            CopyWithRetry(self, HostExe);
        ExtractResource("ciadpi.exe", BackendExe);
        ExtractResource("LICENSE", Path.Combine(InstallDir, "LICENSE-ByeDPI.txt"));

        string manifestPath = Path.Combine(InstallDir, HostName + ".json");
        var manifest = new Dictionary<string, object>
        {
            { "name", HostName },
            { "description", ProductName + " helper" },
            { "path", HostExe },
            { "type", "stdio" },
            { "allowed_extensions", new[] { ExtensionId } },
        };
        File.WriteAllText(manifestPath, new JavaScriptSerializer().Serialize(manifest), new UTF8Encoding(false));

        using (var key = Registry.CurrentUser.CreateSubKey(NativeHostsKey + @"\" + HostName))
            key.SetValue("", manifestPath);
        using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
        {
            key.SetValue("DisplayName", ProductName);
            key.SetValue("DisplayIcon", HostExe);
            key.SetValue("InstallLocation", InstallDir);
            key.SetValue("UninstallString", "\"" + HostExe + "\" --uninstall");
            key.SetValue("NoModify", 1, RegistryValueKind.DWord);
            key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    static void Uninstall()
    {
        StopBackend();
        Registry.CurrentUser.DeleteSubKeyTree(NativeHostsKey + @"\" + HostName, false);
        Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
        using (var parent = Registry.CurrentUser.OpenSubKey(NativeHostsKey))
        {
            if (parent != null && parent.SubKeyCount == 0 && parent.ValueCount == 0)
                Registry.CurrentUser.DeleteSubKey(NativeHostsKey, false);
        }

        if (!Directory.Exists(InstallDir)) return;
        // 실행 중인 자기 자신은 지울 수 없으므로 종료 후 cmd 가 폴더를 지우게 한다
        Process.Start(new ProcessStartInfo("cmd.exe",
            "/c ping -n 3 127.0.0.1 >nul & rmdir /s /q \"" + InstallDir + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetTempPath(),
        });
    }

    static void CopyWithRetry(string from, string to)
    {
        for (int i = 0; ; i++)
        {
            try { File.Copy(from, to, true); return; }
            catch (IOException) { if (i >= 9) throw; Thread.Sleep(300); }
        }
    }

    static void ExtractResource(string name, string path)
    {
        using (var input = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
        using (var output = File.Create(path))
            input.CopyTo(output);
    }

    // ---- 네이티브 메시징 ------------------------------------------------------

    static void RunNativeHost()
    {
        var input = Console.OpenStandardInput();
        var output = Console.OpenStandardOutput();
        var message = ReadMessage(input);
        if (message == null) return;

        Dictionary<string, object> reply;
        // 브라우저 시작 때 메시지가 겹쳐도 ciadpi 가 둘 뜨지 않도록 호스트 인스턴스를 직렬화한다
        using (var mutex = new Mutex(false, @"Local\GoodbyeDPIFirefoxHost"))
        {
            bool owned = false;
            try
            {
                try { owned = mutex.WaitOne(15000); }
                catch (AbandonedMutexException) { owned = true; }
                reply = owned ? Dispatch(message) : Error("다른 요청을 처리하는 중입니다");
            }
            catch (Exception e)
            {
                reply = Error(e.Message);
            }
            finally
            {
                if (owned) mutex.ReleaseMutex();
            }
        }
        reply["protocol"] = Protocol;
        WriteMessage(output, reply);
    }

    static Dictionary<string, object> Dispatch(Dictionary<string, object> message)
    {
        object cmd, args;
        message.TryGetValue("cmd", out cmd);
        switch (cmd as string)
        {
            case "start":
                message.TryGetValue("args", out args);
                return StartBackend((args as string) ?? "");
            case "stop":
                StopBackend();
                return Stopped();
            case "status":
                return Status();
            default:
                return Error("알 수 없는 명령입니다");
        }
    }

    static Dictionary<string, object> ReadMessage(Stream input)
    {
        var header = ReadExactly(input, 4);
        if (header == null) return null;
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > 1024 * 1024) return null;
        var body = ReadExactly(input, length);
        if (body == null) return null;
        return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
    }

    static byte[] ReadExactly(Stream input, int count)
    {
        var buffer = new byte[count];
        int got = 0;
        while (got < count)
        {
            int read = input.Read(buffer, got, count - got);
            if (read <= 0) return null;
            got += read;
        }
        return buffer;
    }

    static void WriteMessage(Stream output, Dictionary<string, object> message)
    {
        var body = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(message));
        output.Write(BitConverter.GetBytes(body.Length), 0, 4);
        output.Write(body, 0, body.Length);
        output.Flush();
    }

    static Dictionary<string, object> Error(string text)
    {
        return new Dictionary<string, object> { { "ok", false }, { "error", text } };
    }

    static Dictionary<string, object> Stopped()
    {
        return new Dictionary<string, object> { { "ok", true }, { "running", false } };
    }

    static Dictionary<string, object> Running(int pid, int port)
    {
        return new Dictionary<string, object> { { "ok", true }, { "running", true }, { "pid", pid }, { "port", port } };
    }

    // ---- ciadpi 관리 ---------------------------------------------------------

    static Dictionary<string, object> Status()
    {
        var state = ReadState();
        if (state != null && IsOurProcess(state.pid) && SocksResponds(state.port))
            return Running(state.pid, state.port);
        return Stopped();
    }

    static Dictionary<string, object> StartBackend(string args)
    {
        var tokens = ParseArguments(args);
        if (tokens == null) return Error("우회 전략 인수가 올바르지 않습니다: " + args);

        // 같은 설정으로 정상 동작 중이면 포트를 바꾸지 않고 그대로 쓴다
        var state = ReadState();
        if (state != null && state.args == args && IsOurProcess(state.pid) && SocksResponds(state.port))
            return Running(state.pid, state.port);

        StopBackend();
        if (!File.Exists(BackendExe)) ExtractResource("ciadpi.exe", BackendExe);

        string failure = "";
        // 빈 포트를 받은 뒤 ciadpi 가 바인드하기 전에 다른 프로그램이 가져갈 수 있어 몇 번 다시 시도한다
        for (int attempt = 0; attempt < 3; attempt++)
        {
            int port = FindFreePort();
            ProcessInformation process;
            try { process = Spawn(tokens, port); }
            catch (Win32Exception e) { return Error("ciadpi 를 실행할 수 없습니다: " + e.Message); }

            try
            {
                for (int waited = 0; waited < 3000; waited += 100)
                {
                    uint exitCode;
                    if (WaitForSingleObject(process.hProcess, 0) == 0 && GetExitCodeProcess(process.hProcess, out exitCode))
                    {
                        failure = "ciadpi 가 바로 종료되었습니다 (코드 " + exitCode + ")";
                        break;
                    }
                    if (SocksResponds(port))
                    {
                        WriteState(new BackendState { pid = process.dwProcessId, port = port, args = args });
                        return Running(process.dwProcessId, port);
                    }
                    Thread.Sleep(100);
                }
                if (failure == "") failure = "ciadpi 가 응답하지 않습니다";
                TerminateProcess(process.hProcess, 1);
            }
            finally
            {
                CloseHandle(process.hProcess);
                CloseHandle(process.hThread);
            }
        }
        return Error(failure);
    }

    // 이 도우미가 설치한 ciadpi 만 종료한다. 경로로 확인하므로 다른 프로그램의 ciadpi 와 재사용된 PID 는 건드리지 않는다.
    static void StopBackend()
    {
        foreach (var process in Process.GetProcessesByName("ciadpi"))
        {
            using (process)
            {
                if (!IsBackendPath(process)) continue;
                try { process.Kill(); process.WaitForExit(2000); }
                catch (Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
        if (File.Exists(StateFile)) File.Delete(StateFile);
    }

    static bool IsOurProcess(int pid)
    {
        try
        {
            using (var process = Process.GetProcessById(pid))
                return IsBackendPath(process);
        }
        catch (ArgumentException) { return false; }
    }

    static bool IsBackendPath(Process process)
    {
        try { return string.Equals(process.MainModule.FileName, BackendExe, StringComparison.OrdinalIgnoreCase); }
        catch (Win32Exception) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    static int FindFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    // 포트가 열려 있는 것만으로는 부족하다. 실제로 SOCKS5 인사에 답해야 정상으로 본다.
    static bool SocksResponds(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var connect = client.BeginConnect(IPAddress.Loopback, port, null, null);
                if (!connect.AsyncWaitHandle.WaitOne(1000)) return false;
                client.EndConnect(connect);
                var stream = client.GetStream();
                stream.ReadTimeout = 1000;
                stream.WriteTimeout = 1000;
                stream.Write(new byte[] { 5, 1, 0 }, 0, 3);
                var reply = ReadExactly(stream, 2);
                return reply != null && reply[0] == 5 && reply[1] == 0;
            }
        }
        catch (SocketException) { return false; }
        catch (IOException) { return false; }
    }

    // 전략 문자열을 인수 목록으로 나눈다. 수신 주소·포트는 도우미가 정하고 파일을 쓰는 옵션은 허용하지 않는다.
    static List<string> ParseArguments(string args)
    {
        var tokens = args.Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList();
        foreach (var token in tokens)
        {
            if (!Regex.IsMatch(token, @"^[\w\-+=:,.*?#]+$")) return null;
            if (Regex.IsMatch(token, @"^(-[ipyD]|--(ip|port|cache-dump|daemon|pidfile)(=|$))")) return null;
        }
        return tokens;
    }

    // Firefox 는 호스트를 Job 에 넣고 응답 후 함께 종료하므로 ciadpi 를 Job 밖에서 실행해야 살아남는다
    static ProcessInformation Spawn(List<string> tokens, int port)
    {
        string commandLine = "\"" + BackendExe + "\" -i 127.0.0.1 -p " + port + " " + string.Join(" ", tokens);
        var startup = new StartupInfo();
        startup.cb = Marshal.SizeOf(startup);
        ProcessInformation process;
        if (!CreateProcessW(BackendExe, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                CreateBreakawayFromJob | CreateNoWindow, IntPtr.Zero, InstallDir, ref startup, out process))
        {
            // Job 밖 실행이 금지된 환경이면 일반 실행으로 되돌린다
            if (Marshal.GetLastWin32Error() != ErrorAccessDenied ||
                !CreateProcessW(BackendExe, commandLine, IntPtr.Zero, IntPtr.Zero, false,
                    CreateNoWindow, IntPtr.Zero, InstallDir, ref startup, out process))
                throw new Win32Exception();
        }
        return process;
    }

    class BackendState
    {
        public int pid { get; set; }
        public int port { get; set; }
        public string args { get; set; }
    }

    static BackendState ReadState()
    {
        try { return new JavaScriptSerializer().Deserialize<BackendState>(File.ReadAllText(StateFile)); }
        catch (IOException) { return null; }
        catch (ArgumentException) { return null; }
        catch (InvalidOperationException) { return null; }
    }

    static void WriteState(BackendState state)
    {
        File.WriteAllText(StateFile, new JavaScriptSerializer().Serialize(state), new UTF8Encoding(false));
    }

    static void Notify(string text, uint icon)
    {
        MessageBoxW(IntPtr.Zero, text, ProductName, icon);
    }

    // ---- Win32 ---------------------------------------------------------------

    const uint CreateBreakawayFromJob = 0x01000000;
    const uint CreateNoWindow = 0x08000000;
    const int ErrorAccessDenied = 5;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(string application, string commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment,
        string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);

    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);
}
