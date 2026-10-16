using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length == 1 && args[0].StartsWith("--smoke-test=", StringComparison.Ordinal))
        {
            RunSmokeTest(args[0].Substring("--smoke-test=".Length));
            return;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ManagerForm(null));
    }

    private static void RunSmokeTest(string resultPath)
    {
        string isolatedData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Teacher Load Manager",
            "Smoke-" + Guid.NewGuid().ToString("N"));
        ManagerForm manager = new ManagerForm(isolatedData);
        try
        {
            manager.PrepareForSmokeTest();
            File.WriteAllText(resultPath, "PASS: local PHP server and isolated MySQL-backed API responded successfully." + Environment.NewLine + isolatedData);
        }
        catch (Exception error)
        {
            File.WriteAllText(resultPath, "FAIL: " + error.Message);
            Environment.ExitCode = 1;
        }
        finally
        {
            manager.StopForSmokeTest();
        }
    }
}

internal sealed class ManagerForm : Form
{
    private const int WebPort = 18437;
    private const int DatabasePort = 18438;
    private readonly string appDirectory = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private readonly string databaseDirectory;
    private readonly bool smokeTestData;
    private readonly Label status = new Label();
    private readonly Button openButton = new Button();
    private readonly Button promoteButton = new Button();
    private readonly TextBox usernameInput = new TextBox();
    private Process webServer;
    private Process databaseServer;
    private bool starting;
    private bool ready;
    private bool databaseStartedHere;

    public ManagerForm(string databaseDirectoryOverride)
    {
        smokeTestData = databaseDirectoryOverride != null;
        databaseDirectory = databaseDirectoryOverride ??
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Teacher Load Manager", "Database");
        Text = "Teacher Load Manager";
        ClientSize = new Size(510, 300);
        MinimumSize = new Size(510, 300);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9F);

        Label title = new Label();
        title.Text = "Teacher Load Manager";
        title.Font = new Font("Segoe UI", 16F, FontStyle.Bold);
        title.AutoSize = true;
        title.Location = new Point(24, 20);
        Controls.Add(title);

        status.Text = "Starting local services…";
        status.AutoSize = true;
        status.Location = new Point(26, 60);
        Controls.Add(status);

        openButton.Text = "Open Teacher Load Manager";
        openButton.Location = new Point(24, 89);
        openButton.Size = new Size(210, 32);
        openButton.Enabled = false;
        openButton.Click += delegate { OpenApp(); };
        Controls.Add(openButton);

        GroupBox adminGroup = new GroupBox();
        adminGroup.Text = "First-time administrator setup";
        adminGroup.Location = new Point(24, 137);
        adminGroup.Size = new Size(458, 112);
        Controls.Add(adminGroup);

        Label instructions = new Label();
        instructions.Text = "Create your account in the app first. Enter its username here, then promote it to administrator.";
        instructions.Location = new Point(12, 23);
        instructions.Size = new Size(430, 36);
        adminGroup.Controls.Add(instructions);

        usernameInput.Location = new Point(14, 65);
        usernameInput.Size = new Size(205, 24);
        usernameInput.Enabled = false;
        adminGroup.Controls.Add(usernameInput);

        promoteButton.Text = "Make first account administrator";
        promoteButton.Location = new Point(228, 62);
        promoteButton.Size = new Size(214, 30);
        promoteButton.Enabled = false;
        promoteButton.Click += delegate { PromoteFirstAdministrator(); };
        adminGroup.Controls.Add(promoteButton);

        Label footer = new Label();
        footer.Text = "Local computer only  •  Close this window to stop the app";
        footer.AutoSize = true;
        footer.ForeColor = Color.DimGray;
        footer.Location = new Point(25, 266);
        Controls.Add(footer);

        Shown += delegate { StartServices(); };
        FormClosing += delegate { StopWebServer(); };
    }

    private void StartServices()
    {
        if (starting || ready) return;
        starting = true;
        status.Text = "Starting MySQL and preparing the local database…";
        openButton.Enabled = false;

        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                PrepareAndStart();
                BeginInvoke((MethodInvoker)delegate
                {
                    ready = true;
                    starting = false;
                    status.Text = "Ready. The app is available on this computer only.";
                    openButton.Enabled = true;
                    usernameInput.Enabled = true;
                    promoteButton.Enabled = true;
                    OpenApp();
                });
            }
            catch (Exception error)
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    starting = false;
                    status.Text = "Could not start the app. See the message for details.";
                    MessageBox.Show(
                        this,
                        error.Message + Environment.NewLine + Environment.NewLine +
                        "Logs are saved in " + GetLogDirectory() + ".",
                        "Teacher Load Manager startup error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error);
                });
            }
        });
    }

    private void PrepareAndStart()
    {
        string xamppDirectory = ReadXamppDirectory();
        string php = Path.Combine(xamppDirectory, "php", "php.exe");
        string mysql = Path.Combine(xamppDirectory, "mysql", "bin", "mysql.exe");
        string mysqld = Path.Combine(xamppDirectory, "mysql", "bin", "mysqld.exe");
        string mysqlInstaller = Path.Combine(xamppDirectory, "mysql", "bin", "mysql_install_db.exe");
        if (!File.Exists(php) || !File.Exists(mysql) || !File.Exists(mysqld) ||
            !File.Exists(mysqlInstaller))
            throw new InvalidOperationException("The selected XAMPP folder is missing PHP or MySQL. Repair XAMPP or reinstall the app and select the correct XAMPP folder.");

        Directory.CreateDirectory(GetLogDirectory());
        EnsurePrivateDatabaseIsRunning(xamppDirectory, mysqlInstaller, mysqld, mysql);

        string config = Path.Combine(appDirectory, "db-config.php");
        if (!File.Exists(config))
            ConfigureDatabase(mysql);

        DatabaseConfig settings = ReadDatabaseConfig(config);
        if (settings.Host != "127.0.0.1" || settings.Port != DatabasePort ||
            settings.Database != "teacher_load_manager")
            throw new InvalidOperationException("The app is configured for a non-local or unsupported database. Restore the local XAMPP settings or reinstall the app.");

        string optionsFile = WriteMySqlOptions(settings);
        try
        {
            string schemaFile = Path.Combine(appDirectory, "database-schema.sql");
            string schema = File.ReadAllText(schemaFile, Encoding.UTF8);
            string arguments = "--defaults-extra-file=" + Quote(optionsFile) +
                " --protocol=tcp --host=127.0.0.1 --port=" + DatabasePort + " --database=teacher_load_manager --default-character-set=utf8mb4";
            RunMySql(mysql, arguments, schema, 30000);
        }
        finally
        {
            try { File.Delete(optionsFile); }
            catch (IOException) { }
        }

        StartWebServer(php);
        WaitForWebServer();
    }

    public void PrepareForSmokeTest()
    {
        PrepareAndStart();
        string url = "http://127.0.0.1:" + WebPort + "/api.php?action=session";
        CookieContainer cookies = new CookieContainer();
        HttpWebRequest sessionRequest = (HttpWebRequest)WebRequest.Create(url);
        sessionRequest.Timeout = 3000;
        sessionRequest.CookieContainer = cookies;
        string sessionJson;
        using (HttpWebResponse response = (HttpWebResponse)sessionRequest.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            sessionJson = reader.ReadToEnd();
        Match csrf = Regex.Match(sessionJson, "\"csrfToken\"\\s*:\\s*\"([0-9a-f]{64})\"");
        if (!csrf.Success)
            throw new InvalidOperationException("The app session endpoint did not return a CSRF token.");

        HttpWebRequest loginRequest = (HttpWebRequest)WebRequest.Create(
            "http://127.0.0.1:" + WebPort + "/api.php?action=login");
        loginRequest.Method = "POST";
        loginRequest.ContentType = "application/json";
        loginRequest.Headers["X-CSRF-Token"] = csrf.Groups[1].Value;
        loginRequest.CookieContainer = cookies;
        byte[] body = Encoding.UTF8.GetBytes("{\"identifier\":\"installer-smoke-test-user\",\"password\":\"invalid\"}");
        loginRequest.ContentLength = body.Length;
        using (Stream requestStream = loginRequest.GetRequestStream())
            requestStream.Write(body, 0, body.Length);

        string responseJson;
        HttpStatusCode statusCode;
        try
        {
            using (HttpWebResponse response = (HttpWebResponse)loginRequest.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                statusCode = response.StatusCode;
                responseJson = reader.ReadToEnd();
            }
        }
        catch (WebException error)
        {
            HttpWebResponse response = error.Response as HttpWebResponse;
            if (response == null) throw new InvalidOperationException("The login API did not return an HTTP response.", error);
            statusCode = response.StatusCode;
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                responseJson = reader.ReadToEnd();
        }

        if (statusCode != HttpStatusCode.Unauthorized ||
            responseJson.IndexOf("Incorrect username/email or password", StringComparison.Ordinal) < 0)
            throw new InvalidOperationException("The app API could not verify its initialized MySQL account. Response: " + responseJson);

        DatabaseConfig settings = ReadDatabaseConfig(Path.Combine(appDirectory, "db-config.php"));
        string mysql = Path.Combine(ReadXamppDirectory(), "mysql", "bin", "mysql.exe");
        string testUsername = "smoke" + RandomHex(6);
        string testId = Guid.NewGuid().ToString();
        string insertSql = "INSERT INTO users (id, username, password_hash, role, teacher_id) VALUES ('" +
            testId + "', '" + testUsername + "', 'smoke-test-hash', 'teacher', '" + testId + "');\n";
        ExecuteApplicationSql(mysql, settings, insertSql);
        try
        {
            if (!PromoteFirstAdministratorAccount(testUsername))
                throw new InvalidOperationException("The first-administrator setup could not promote a new local account.");
            if (PromoteFirstAdministratorAccount("smoke-no-such-user"))
                throw new InvalidOperationException("The first-administrator setup allowed another administrator to be promoted.");
        }
        finally
        {
            ExecuteApplicationSql(mysql, settings,
                "DELETE FROM users WHERE username='" + testUsername + "';\n");
        }
    }

    public void StopForSmokeTest()
    {
        StopWebServer();
        if (databaseStartedHere)
        {
            try
            {
                string xampp = ReadXamppDirectory();
                string admin = Path.Combine(xampp, "mysql", "bin", "mysqladmin.exe");
                if (File.Exists(admin))
                {
                    ProcessStartInfo start = new ProcessStartInfo();
                    start.FileName = admin;
                    start.Arguments = "--protocol=tcp --host=127.0.0.1 --port=" + DatabasePort + " --user=root shutdown";
                    start.UseShellExecute = false;
                    start.CreateNoWindow = true;
                    start.RedirectStandardOutput = true;
                    start.RedirectStandardError = true;
                    using (Process process = Process.Start(start))
                    {
                        process.WaitForExit(10000);
                        if (!process.HasExited) process.Kill();
                    }
                }
            }
            catch (IOException) { }
            catch (InvalidOperationException) { }
            catch (Win32Exception) { }
        }
        if (databaseServer != null)
        {
            try
            {
                if (!databaseServer.HasExited) databaseServer.WaitForExit(10000);
            }
            catch (InvalidOperationException) { }
        }
        if (smokeTestData && Directory.Exists(databaseDirectory))
        {
            try { Directory.Delete(databaseDirectory, true); }
            catch (IOException) { }
        }
    }

    private string ReadXamppDirectory()
    {
        string pathFile = Path.Combine(appDirectory, "xampp-path.txt");
        if (!File.Exists(pathFile))
            throw new InvalidOperationException("The XAMPP folder was not saved during installation. Run the installer again and select your XAMPP folder.");
        string path = File.ReadAllText(pathFile).Trim();
        if (!Path.IsPathRooted(path))
            throw new InvalidOperationException("The saved XAMPP path is invalid. Run the installer again and select the XAMPP folder.");
        return Path.GetFullPath(path);
    }

    private void EnsurePrivateDatabaseIsRunning(string xamppDirectory, string mysqlInstaller, string mysqld, string mysql)
    {
        if (IsTcpPortOpen(DatabasePort))
            throw new InvalidOperationException("Port " + DatabasePort + " is already in use. Close the program using it, then start Teacher Load Manager again.");

        if (!Directory.Exists(databaseDirectory))
            Directory.CreateDirectory(databaseDirectory);
        string systemTables = Path.Combine(databaseDirectory, "mysql");
        string privateConfig = Path.Combine(databaseDirectory, "my.ini");
        if (!Directory.Exists(systemTables))
        {
            string initializeArguments = Quote("--datadir=" + databaseDirectory) +
                " --port=" + DatabasePort + " --default-user --silent";
            RunInitializer(mysqlInstaller, initializeArguments, Path.GetDirectoryName(mysqlInstaller), 60000);
        }
        else if (!File.Exists(privateConfig))
        {
            throw new InvalidOperationException("The private database folder is incomplete. It was left untouched; back it up before repairing or reinstalling the app.");
        }

        if (!File.Exists(privateConfig))
            throw new InvalidOperationException("MySQL did not create its private configuration file. Check that the app's data folder is writable.");
        WritePrivateMySqlConfig(privateConfig, xamppDirectory);

        string arguments = "--defaults-file=" + Quote(privateConfig) + " --standalone --bind-address=127.0.0.1 --port=" + DatabasePort;
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = mysqld;
        start.Arguments = arguments;
        start.WorkingDirectory = Path.Combine(xamppDirectory, "mysql", "bin");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        databaseServer = StartLoggedProcess(start, "mysql.log");
        databaseStartedHere = true;

        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            if (databaseServer.HasExited)
                throw new InvalidOperationException("The app's private MySQL server stopped while starting. Check the MySQL log.");
            if (IsTcpPortOpen(DatabasePort))
            {
                WaitForPrivateMySql(mysql);
                return;
            }
            Thread.Sleep(250);
        }
        throw new InvalidOperationException("The app's private MySQL server did not start on port " + DatabasePort + ". Check the MySQL log.");
    }

    private static void RunInitializer(string executable, string arguments, string workingDirectory, int timeout)
    {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = arguments;
        start.WorkingDirectory = workingDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (Process process = Process.Start(start))
        {
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(timeout))
            {
                process.Kill();
                throw new InvalidOperationException("The private database setup timed out.");
            }
            if (process.ExitCode != 0)
                throw new InvalidOperationException("Could not initialize the private database. " + (error + Environment.NewLine + output).Trim());
        }
    }

    private void WritePrivateMySqlConfig(string path, string xamppDirectory)
    {
        string mysqlDirectory = Path.Combine(xamppDirectory, "mysql").Replace("\\", "/");
        string dataPath = databaseDirectory.Replace("\\", "/");
        string tempPath = Path.Combine(databaseDirectory, "tmp").Replace("\\", "/");
        Directory.CreateDirectory(Path.Combine(databaseDirectory, "tmp"));
        string contents =
            "[mysqld]\r\n" +
            "basedir=\"" + mysqlDirectory + "\"\r\n" +
            "datadir=\"" + dataPath + "\"\r\n" +
            "tmpdir=\"" + tempPath + "\"\r\n" +
            "port=" + DatabasePort + "\r\n" +
            "bind-address=127.0.0.1\r\n" +
            "character-set-server=utf8mb4\r\n" +
            "default-storage-engine=InnoDB\r\n" +
            "log_error=\"" + Path.Combine(GetLogDirectory(), "mariadb.log").Replace("\\", "/") + "\"\r\n" +
            "[client]\r\nhost=127.0.0.1\r\nport=" + DatabasePort + "\r\n";
        File.WriteAllText(path, contents, new UTF8Encoding(false));
    }

    private void WaitForPrivateMySql(string mysql)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(30);
        Exception lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            if (databaseServer.HasExited)
                throw new InvalidOperationException("The app's private MySQL server stopped while starting. Check the MySQL log.");
            try
            {
                RunMySql(mysql,
                    "--protocol=tcp --host=127.0.0.1 --port=" + DatabasePort + " --user=root --batch --skip-column-names",
                    "SELECT 1;\n",
                    3000);
                return;
            }
            catch (InvalidOperationException error)
            {
                lastError = error;
                Thread.Sleep(300);
            }
        }
        throw new InvalidOperationException("The private database did not become ready. " +
            (lastError == null ? "" : lastError.Message));
    }

    private void ConfigureDatabase(string mysql)
    {
        string token = RandomHex(32);
        string username = "tlm" + token.Substring(0, 12);
        string password = token;
        string sql =
            "CREATE DATABASE IF NOT EXISTS teacher_load_manager CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n" +
            "CREATE USER '" + username + "'@'127.0.0.1' IDENTIFIED BY '" + password + "';\n" +
            "GRANT ALL PRIVILEGES ON teacher_load_manager.* TO '" + username + "'@'127.0.0.1';\n";

        try
        {
            RunMySql(mysql, "--protocol=tcp --host=127.0.0.1 --port=" + DatabasePort + " --user=root", sql, 30000);
        }
        catch (Exception error)
        {
            throw new InvalidOperationException(
                "The app could not prepare its private MySQL account. This installer expects XAMPP's default local root account (no password). " +
                "If you changed the MySQL root password, start XAMPP and check its MySQL settings before trying again. " + error.Message);
        }

        string contents =
            "<?php\r\ndeclare(strict_types=1);\r\n\r\nreturn [\r\n" +
            "    'host' => '127.0.0.1',\r\n" +
            "    'port' => " + DatabasePort + ",\r\n" +
            "    'database' => 'teacher_load_manager',\r\n" +
            "    'username' => '" + username + "',\r\n" +
            "    'password' => '" + password + "',\r\n" +
            "];\r\n";
        string configPath = Path.Combine(appDirectory, "db-config.php");
        File.WriteAllText(configPath, contents, new UTF8Encoding(false));
    }

    private static string RandomHex(int byteCount)
    {
        byte[] bytes = new byte[byteCount];
        using (RandomNumberGenerator random = new RNGCryptoServiceProvider())
            random.GetBytes(bytes);
        StringBuilder value = new StringBuilder(bytes.Length * 2);
        foreach (byte item in bytes) value.Append(item.ToString("x2"));
        return value.ToString();
    }

    private DatabaseConfig ReadDatabaseConfig(string path)
    {
        string content = File.ReadAllText(path);
        DatabaseConfig result = new DatabaseConfig();
        result.Host = ReadConfigValue(content, "host");
        result.Database = ReadConfigValue(content, "database");
        result.Username = ReadConfigValue(content, "username");
        result.Password = ReadConfigValue(content, "password");
        string port = ReadConfigValue(content, "port");
        if (!Int32.TryParse(port, out result.Port) || result.Username.Length == 0 || result.Password.Length == 0)
            throw new InvalidOperationException("The local database configuration is incomplete. Reinstall the app or contact support.");
        return result;
    }

    private static string ReadConfigValue(string content, string key)
    {
        Match match = Regex.Match(content,
            "'" + Regex.Escape(key) + @"'\s*=>\s*(?:'([^']*)'|([0-9]+))");
        if (!match.Success) throw new InvalidOperationException("The local database configuration is invalid. Reinstall the app.");
        return match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
    }

    private string WriteMySqlOptions(DatabaseConfig settings)
    {
        string file = Path.Combine(Path.GetTempPath(), "teacher-load-manager-" + Guid.NewGuid().ToString("N") + ".cnf");
        string content = "[client]\r\nuser=" + settings.Username + "\r\npassword=" + settings.Password +
            "\r\nhost=127.0.0.1\r\nport=" + DatabasePort + "\r\n";
        File.WriteAllText(file, content, new UTF8Encoding(false));
        return file;
    }

    private void RunMySql(string executable, string arguments, string input, int timeout)
    {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = arguments;
        start.WorkingDirectory = Path.GetDirectoryName(executable);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;

        StringBuilder errors = new StringBuilder();
        using (Process process = Process.Start(start))
        {
            process.OutputDataReceived += delegate { };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null) lock (errors) errors.AppendLine(args.Data);
            };
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.StandardInput.Write(input);
            process.StandardInput.Close();
            if (!process.WaitForExit(timeout))
            {
                process.Kill();
                throw new InvalidOperationException("The MySQL setup command timed out.");
            }
            process.WaitForExit();
            if (process.ExitCode != 0)
            {
                string details;
                lock (errors) details = errors.ToString().Trim();
                if (details.Length > 1200) details = details.Substring(0, 1200);
                throw new InvalidOperationException("MySQL returned an error. " + details);
            }
        }
    }

    private void StartWebServer(string php)
    {
        if (IsTcpPortOpen(WebPort))
            throw new InvalidOperationException("Port " + WebPort + " is already in use. Close the other program using it, then start the app again.");

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = php;
        start.Arguments = "-S 127.0.0.1:" + WebPort + " -t " + Quote(appDirectory);
        start.WorkingDirectory = appDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        webServer = StartLoggedProcess(start, "server.log");
    }

    private Process StartLoggedProcess(ProcessStartInfo start, string logName)
    {
        string log = Path.Combine(GetLogDirectory(), logName);
        Process process = Process.Start(start);
        StreamWriter writer = new StreamWriter(new FileStream(log, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), Encoding.UTF8);
        writer.AutoFlush = true;
        process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            if (args.Data != null) lock (writer) writer.WriteLine(args.Data);
        };
        process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
        {
            if (args.Data != null) lock (writer) writer.WriteLine(args.Data);
        };
        process.Exited += delegate
        {
            try { lock (writer) writer.Dispose(); }
            catch (ObjectDisposedException) { }
        };
        process.EnableRaisingEvents = true;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private void WaitForWebServer()
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            if (webServer.HasExited)
                throw new InvalidOperationException("PHP stopped while starting the local app. Check XAMPP PHP and the server log.");
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + WebPort + "/");
                request.Timeout = 1000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    if ((int)response.StatusCode >= 200 && (int)response.StatusCode < 400) return;
            }
            catch (WebException) { }
            Thread.Sleep(250);
        }
        throw new InvalidOperationException("The local PHP server did not respond. Check the server log.");
    }

    private static bool IsTcpPortOpen(int port)
    {
        using (TcpClient client = new TcpClient())
        {
            IAsyncResult connection = client.BeginConnect(IPAddress.Loopback, port, null, null);
            try { return connection.AsyncWaitHandle.WaitOne(350) && client.Connected; }
            catch (SocketException) { return false; }
            finally
            {
                try { client.EndConnect(connection); }
                catch (SocketException) { }
                catch (InvalidOperationException) { }
            }
        }
    }

    private void OpenApp()
    {
        try { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + WebPort + "/") { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show(this, error.Message, "Could not open the browser", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void PromoteFirstAdministrator()
    {
        string username = usernameInput.Text.Trim();
        if (!Regex.IsMatch(username, @"^[a-zA-Z0-9._-]{3,40}$"))
        {
            MessageBox.Show(this, "Enter the username you used to create your teacher account.", "Check the username", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        promoteButton.Enabled = false;
        ThreadPool.QueueUserWorkItem(delegate
        {
            try
            {
                bool promoted = PromoteFirstAdministratorAccount(username);
                BeginInvoke((MethodInvoker)delegate
                {
                    promoteButton.Enabled = true;
                    MessageBox.Show(this,
                        promoted
                            ? "Your account is now an administrator. Sign out and sign in again to access the administrator controls."
                            : "No account was changed. Check the username, and make sure you have not already created an administrator account.",
                        "Administrator setup",
                        MessageBoxButtons.OK,
                        promoted ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                });
            }
            catch (Exception error)
            {
                BeginInvoke((MethodInvoker)delegate
                {
                    promoteButton.Enabled = true;
                    MessageBox.Show(this, error.Message, "Administrator setup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                });
            }
        });
    }

    private bool PromoteFirstAdministratorAccount(string username)
    {
        DatabaseConfig settings = ReadDatabaseConfig(Path.Combine(appDirectory, "db-config.php"));
        string mysql = Path.Combine(ReadXamppDirectory(), "mysql", "bin", "mysql.exe");
        string escapedUsername = username.Replace("\\", "\\\\").Replace("'", "\\'");
        string sql =
            "UPDATE users SET role='admin' WHERE username='" + escapedUsername +
            "' AND NOT EXISTS (SELECT role FROM (SELECT role FROM users WHERE role='admin') AS existing_admins);\n" +
            "SELECT ROW_COUNT();\n";
        string output = ExecuteApplicationSqlForOutput(mysql, settings, sql);
        string[] lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
        return lines.Length > 0 && lines[0].Trim() == "1";
    }

    private void ExecuteApplicationSql(string executable, DatabaseConfig settings, string sql)
    {
        string optionsFile = WriteMySqlOptions(settings);
        try
        {
            RunMySql(executable,
                "--defaults-extra-file=" + Quote(optionsFile) +
                " --protocol=tcp --host=127.0.0.1 --port=" + DatabasePort + " --database=teacher_load_manager",
                sql,
                15000);
        }
        finally
        {
            try { File.Delete(optionsFile); }
            catch (IOException) { }
        }
    }

    private string ExecuteApplicationSqlForOutput(string executable, DatabaseConfig settings, string sql)
    {
        string optionsFile = WriteMySqlOptions(settings);
        try
        {
            return RunMySqlForOutput(executable,
                "--defaults-extra-file=" + Quote(optionsFile) +
                " --protocol=tcp --host=127.0.0.1 --port=" + DatabasePort +
                " --database=teacher_load_manager --batch --skip-column-names",
                sql);
        }
        finally
        {
            try { File.Delete(optionsFile); }
            catch (IOException) { }
        }
    }

    private string RunMySqlForOutput(string executable, string arguments, string input)
    {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = executable;
        start.Arguments = arguments;
        start.WorkingDirectory = Path.GetDirectoryName(executable);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        using (Process process = Process.Start(start))
        {
            process.StandardInput.Write(input);
            process.StandardInput.Close();
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(15000))
            {
                process.Kill();
                throw new InvalidOperationException("The MySQL administrator setup command timed out.");
            }
            if (process.ExitCode != 0)
                throw new InvalidOperationException("MySQL could not update the first administrator account. " + error.Trim());
            return output.Trim();
        }
    }

    private void StopWebServer()
    {
        if (webServer != null && !webServer.HasExited)
        {
            try { webServer.Kill(); }
            catch (InvalidOperationException) { }
        }
    }

    private static string GetLogDirectory()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Teacher Load Manager",
            "logs");
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private sealed class DatabaseConfig
    {
        public string Host;
        public int Port;
        public string Database;
        public string Username;
        public string Password;
    }
}
