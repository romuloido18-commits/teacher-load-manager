<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

ini_set('session.use_strict_mode', '1');
ini_set('session.cookie_httponly', '1');
ini_set('session.cookie_samesite', 'Strict');
session_set_cookie_params([
    'httponly' => true,
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'samesite' => 'Strict',
    'path' => '/',
]);
session_start();

final class ApiError extends RuntimeException
{
    public int $status;
    public string $errorCode;

    public function __construct(
        string $message,
        int $status = 400,
        string $errorCode = ''
    ) {
        parent::__construct($message);
        $this->status = $status;
        $this->errorCode = $errorCode;
    }
}

function respond(int $status, array $data = []): void
{
    http_response_code($status);
    if (isset($_SESSION['csrf_token'])) {
        $data['csrfToken'] = $_SESSION['csrf_token'];
    }
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function database(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    $configPath = __DIR__ . DIRECTORY_SEPARATOR . 'db-config.php';
    if (!is_file($configPath)) {
        throw new ApiError('Create db-config.php from the supplied local settings before starting the app.', 500);
    }
    $config = require $configPath;
    if (!is_array($config)) {
        throw new ApiError('The database configuration is invalid.', 500);
    }
    $host = (string)($config['host'] ?? '127.0.0.1');
    $port = (int)($config['port'] ?? 3306);
    $name = (string)($config['database'] ?? 'teacher_load_manager');
    $charset = 'utf8mb4';
    $dsn = "mysql:host={$host};port={$port};dbname={$name};charset={$charset}";
    try {
        $pdo = new PDO($dsn, (string)($config['username'] ?? ''), (string)($config['password'] ?? ''), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    } catch (PDOException $error) {
        error_log('Teacher Load Manager database connection failed: ' . $error->getMessage());
        throw new ApiError('Could not connect to MySQL. Check XAMPP and db-config.php.', 503);
    }
    return $pdo;
}

function readInput(): array
{
    $length = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > 4_000_000) {
        throw new ApiError('The request is too large.', 413);
    }
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 4_000_000) {
        throw new ApiError('The request could not be read or is too large.', 413);
    }
    $input = json_decode($raw, true);
    if (!is_array($input)) {
        throw new ApiError('Request details must be a JSON object.');
    }
    return $input;
}

function requireMethod(string $method): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== $method) {
        header('Allow: ' . $method);
        throw new ApiError("Use {$method} for this operation.", 405);
    }
}

function validateOrigin(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') {
        return;
    }
    $parts = parse_url($origin);
    $originHost = strtolower((string)($parts['host'] ?? ''));
    if (isset($parts['port'])) {
        $originHost .= ':' . $parts['port'];
    }
    if ($originHost === '' || !hash_equals(strtolower((string)($_SERVER['HTTP_HOST'] ?? '')), $originHost)) {
        throw new ApiError('Cross-origin requests are not allowed.', 403);
    }
}

function verifyCsrf(): void
{
    $provided = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    $expected = (string)($_SESSION['csrf_token'] ?? '');
    if ($expected === '' || $provided === '' || !hash_equals($expected, $provided)) {
        throw new ApiError('Your session token expired. Refresh the page and try again.', 403);
    }
}

function csrfToken(): string
{
    if (!isset($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return $_SESSION['csrf_token'];
}

function rotateCsrfToken(): void
{
    $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
}

function uuid(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' .
        substr($hex, 16, 4) . '-' . substr($hex, 20);
}

function profileFromRow(array $row): array
{
    return [
        'id' => (string)$row['id'],
        'email' => $row['email'] === null ? '' : (string)$row['email'],
        'username' => (string)$row['username'],
        'role' => (string)$row['role'],
        'teacherId' => (string)$row['teacher_id'],
        'mustChangePassword' => (bool)$row['must_change_password'],
    ];
}

function currentUser(): ?array
{
    if (!isset($_SESSION['user_id'])) {
        return null;
    }
    $statement = database()->prepare(
        'SELECT id, email, username, role, teacher_id, must_change_password FROM users WHERE id = ?'
    );
    $statement->execute([(string)$_SESSION['user_id']]);
    $row = $statement->fetch();
    if (!$row) {
        unset($_SESSION['user_id']);
        return null;
    }
    return profileFromRow($row);
}

function requireUser(): array
{
    $user = currentUser();
    if ($user === null) {
        throw new ApiError('Sign in to continue.', 401);
    }
    return $user;
}

function requireAdmin(array $user): void
{
    if ($user['role'] !== 'admin') {
        throw new ApiError('Only administrators can perform this operation.', 403);
    }
}

function requireReadyAccount(array $user): void
{
    if ($user['mustChangePassword']) {
        throw new ApiError('Change your temporary password before accessing school records.', 403);
    }
}

function fetchSchoolState(PDO $pdo, bool $lock = false): array
{
    $statement = $pdo->query('SELECT data_json, revision FROM school_state WHERE id = 1' . ($lock ? ' FOR UPDATE' : ''));
    $row = $statement->fetch();
    if (!$row) {
        throw new ApiError('The school database has not been initialized. Import database-schema.sql.', 500);
    }
    $data = json_decode((string)$row['data_json'], true);
    if (!is_array($data)) {
        throw new ApiError('The saved school records are invalid JSON.', 500);
    }
    if (($data['settings'] ?? null) === []) {
        $data['settings'] = (object)[];
    }
    return [
        'data' => $data,
        'revision' => (int)$row['revision'],
    ];
}

function saveSchoolState(PDO $pdo, array $data, int $revision): int
{
    $statement = $pdo->prepare('UPDATE school_state SET data_json = ?, revision = revision + 1 WHERE id = 1 AND revision = ?');
    $statement->execute([
        json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_THROW_ON_ERROR),
        $revision,
    ]);
    if ($statement->rowCount() !== 1) {
        throw new ApiError('School records were changed by another user. Reload the latest records and retry.', 409, 'CONFLICT');
    }
    return $revision + 1;
}

function validUsername(string $username): bool
{
    return preg_match('/^[a-zA-Z0-9._-]{3,40}$/', $username) === 1;
}

function arrayIsList(array $value): bool
{
    $index = 0;
    foreach ($value as $key => $_) {
        if ($key !== $index++) {
            return false;
        }
    }
    return true;
}

function validDateRange(mixed $start, mixed $end): bool
{
    if (!is_string($start) || !is_string($end) ||
        !preg_match('/^\d{4}-\d{2}-\d{2}$/', $start) ||
        !preg_match('/^\d{4}-\d{2}-\d{2}$/', $end) ||
        $start > $end) {
        return false;
    }
    return checkdate((int)substr($start, 5, 2), (int)substr($start, 8, 2), (int)substr($start, 0, 4)) &&
        checkdate((int)substr($end, 5, 2), (int)substr($end, 8, 2), (int)substr($end, 0, 4));
}

function loadVisibleState(array $data, array $user): array
{
    foreach (['teachers', 'loads', 'substitutionPlans', 'leaveApplications'] as $key) {
        if (!isset($data[$key]) || !is_array($data[$key])) {
            $data[$key] = [];
        }
    }
    if (!isset($data['settings']) || (!is_array($data['settings']) && !is_object($data['settings']))) {
        $data['settings'] = (object)[];
    } elseif ($data['settings'] === []) {
        $data['settings'] = (object)[];
    }
    if ($user['role'] === 'admin') {
        return $data;
    }
    $teacherId = $user['teacherId'];
    $visibleTeachers = [];
    foreach ($data['teachers'] as $teacher) {
        if (!is_array($teacher)) {
            continue;
        }
        $visibleTeachers[] = (string)($teacher['id'] ?? '') === $teacherId
            ? $teacher
            : array_intersect_key($teacher, array_flip(['id', 'name', 'status']));
    }
    $visibleLoads = [];
    foreach ($data['loads'] as $load) {
        if (!is_array($load)) {
            continue;
        }
        $visibleLoads[] = (string)($load['teacherId'] ?? '') === $teacherId
            ? $load
            : array_intersect_key($load, array_flip(['id', 'teacherId', 'groupName', 'period', 'schedule', 'days']));
    }
    $visiblePlans = [];
    foreach ($data['substitutionPlans'] as $plan) {
        if (!is_array($plan)) {
            continue;
        }
        if (($plan['leaveTeacherId'] ?? '') === $teacherId ||
            ($plan['submittedBy'] ?? '') === $user['id'] ||
            ($plan['substituteTeacherId'] ?? '') === $teacherId) {
            $visiblePlans[] = (($plan['leaveTeacherId'] ?? '') === $teacherId || ($plan['submittedBy'] ?? '') === $user['id'])
                ? $plan
                : array_intersect_key($plan, array_flip(['id', 'substituteTeacherId', 'startDate', 'endDate', 'loadIds', 'status']));
        }
    }
    $data['teachers'] = $visibleTeachers;
    $data['loads'] = $visibleLoads;
    $data['substitutionPlans'] = $visiblePlans;
    $data['leaveApplications'] = array_values(array_filter(
        $data['leaveApplications'],
        static fn($application) => is_array($application) && ($application['teacherId'] ?? '') === $teacherId
    ));
    return $data;
}

function validateSchoolData(mixed $data): array
{
    if (!is_array($data)) {
        throw new ApiError('School records have an invalid format.');
    }
    foreach (['teachers', 'loads', 'substitutionPlans', 'leaveApplications'] as $key) {
        if (!isset($data[$key]) || !is_array($data[$key]) || !arrayIsList($data[$key])) {
            throw new ApiError('School records have an invalid format.');
        }
    }
    if (!isset($data['settings']) || !is_array($data['settings']) ||
        ($data['settings'] !== [] && arrayIsList($data['settings']))) {
        throw new ApiError('School settings have an invalid format.');
    }
    if ($data['settings'] === []) {
        $data['settings'] = (object)[];
    }
    return $data;
}

function unchangedRecord(array $records, array $record): bool
{
    foreach ($records as $saved) {
        if (is_array($saved) && ($saved['id'] ?? null) === ($record['id'] ?? null) && $saved == $record) {
            return true;
        }
    }
    return false;
}

function mergeTeacherState(array $stored, array $submitted, array $user): array
{
    $teacherId = $user['teacherId'];
    $userId = $user['id'];
    $teacher = null;
    foreach ($stored['teachers'] as $row) {
        if (is_array($row) && ($row['id'] ?? '') === $teacherId) {
            $teacher = $row;
            break;
        }
    }
    if ($teacher === null) {
        throw new ApiError('Your teacher profile could not be found.', 403);
    }
    $submittedLoads = array_values(array_filter($submitted['loads'], static fn($load) =>
        is_array($load) && ($load['teacherId'] ?? '') === $teacherId
    ));
    foreach ($submittedLoads as $load) {
        if (!is_string($load['id'] ?? null) || !is_array($load['days'] ?? null)) {
            throw new ApiError('A teaching assignment has invalid required fields.');
        }
    }
    $submittedApplications = [];
    foreach ($submitted['leaveApplications'] as $application) {
        if (!is_array($application)) {
            throw new ApiError('A leave application has an invalid format.');
        }
        if (($application['teacherId'] ?? '') !== $teacherId || ($application['submittedBy'] ?? '') !== $userId) {
            continue;
        }
        if (($application['status'] ?? '') !== 'pending') {
            if (unchangedRecord($stored['leaveApplications'], $application)) {
                continue;
            }
            throw new ApiError('Reviewed leave applications cannot be changed by a teacher.');
        }
        if (!validDateRange($application['startDate'] ?? null, $application['endDate'] ?? null)) {
            throw new ApiError('Leave applications must have a valid date range.');
        }
        $submittedApplications[] = $application;
    }
    $submittedPlans = [];
    foreach ($submitted['substitutionPlans'] as $plan) {
        if (!is_array($plan)) {
            throw new ApiError('A substitution proposal has an invalid format.');
        }
        if (($plan['leaveTeacherId'] ?? '') !== $teacherId || ($plan['submittedBy'] ?? '') !== $userId) {
            continue;
        }
        if (($plan['status'] ?? '') !== 'pending') {
            if (unchangedRecord($stored['substitutionPlans'], $plan)) {
                continue;
            }
            throw new ApiError('Reviewed coverage proposals cannot be changed by a teacher.');
        }
        if (!validDateRange($plan['startDate'] ?? null, $plan['endDate'] ?? null) ||
            !is_array($plan['loadIds'] ?? null) || count($plan['loadIds']) === 0) {
            throw new ApiError('Coverage proposals must have a valid date range and at least one assignment.');
        }
        $selectedLoads = array_column($submittedLoads, 'id');
        if (array_diff($plan['loadIds'], $selectedLoads) !== []) {
            throw new ApiError('Coverage proposals can only include your own teaching assignments.');
        }
        $substitute = null;
        foreach ($stored['teachers'] as $candidate) {
            if (is_array($candidate) && ($candidate['id'] ?? '') === ($plan['substituteTeacherId'] ?? '')) {
                $substitute = $candidate;
                break;
            }
        }
        if (($teacher['status'] ?? '') !== 'On leave' || $substitute === null ||
            ($substitute['id'] ?? '') === $teacherId || ($substitute['status'] ?? 'Active') !== 'Active') {
            throw new ApiError('The leave status or selected substitute is no longer valid.');
        }
        $submittedPlans[] = $plan;
    }
    $stored['loads'] = array_values(array_merge(
        array_filter($stored['loads'], static fn($load) => !is_array($load) || ($load['teacherId'] ?? '') !== $teacherId),
        $submittedLoads
    ));
    $stored['leaveApplications'] = array_values(array_merge(
        array_filter($stored['leaveApplications'], static fn($application) =>
            !is_array($application) || !(($application['teacherId'] ?? '') === $teacherId &&
                ($application['submittedBy'] ?? '') === $userId && ($application['status'] ?? '') === 'pending')
        ),
        $submittedApplications
    ));
    $stored['substitutionPlans'] = array_values(array_merge(
        array_filter($stored['substitutionPlans'], static fn($plan) =>
            !is_array($plan) || !(($plan['leaveTeacherId'] ?? '') === $teacherId &&
                ($plan['submittedBy'] ?? '') === $userId && ($plan['status'] ?? '') === 'pending')
        ),
        $submittedPlans
    ));
    return $stored;
}

function runApi(): void
{
    validateOrigin();
    $action = (string)($_GET['action'] ?? '');
    if ($action === 'session') {
        requireMethod('GET');
        csrfToken();
        respond(200, ['profile' => currentUser()]);
    }
    if ($action === 'login' || $action === 'register') {
        requireMethod('POST');
        verifyCsrf();
        $input = readInput();
        if ($action === 'login') {
            $identifier = trim((string)($input['identifier'] ?? ''));
            $password = (string)($input['password'] ?? '');
            if ($identifier === '' || strlen($identifier) > 254 || $password === '' || strlen($password) > 1024) {
                throw new ApiError('Enter a valid username or email and password.', 401);
            }
            $field = str_contains($identifier, '@') ? 'email' : 'username';
            $statement = database()->prepare(
                "SELECT id, email, username, role, teacher_id, must_change_password, password_hash FROM users WHERE {$field} = ?"
            );
                $statement->execute([strtolower($identifier)]);
            $row = $statement->fetch();
            if (!$row || !password_verify($password, (string)$row['password_hash'])) {
                throw new ApiError('Incorrect username/email or password.', 401);
            }
            session_regenerate_id(true);
            $_SESSION['user_id'] = (string)$row['id'];
            rotateCsrfToken();
            respond(200, ['profile' => profileFromRow($row)]);
        }
        $username = strtolower(trim((string)($input['username'] ?? '')));
        $email = strtolower(trim((string)($input['email'] ?? '')));
        $password = (string)($input['password'] ?? '');
        $fullName = trim((string)($input['fullName'] ?? ''));
        $employeeId = trim((string)($input['employeeId'] ?? ''));
        $position = trim((string)($input['position'] ?? ''));
        if (!validUsername($username) || !filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 254 ||
            strlen($password) < 8 || strlen($password) > 128 || $fullName === '' || strlen($fullName) > 100 ||
            strlen($employeeId) > 40 || strlen($position) > 80) {
            throw new ApiError('Check the username, email, password, and teacher details.');
        }
        $pdo = database();
        $pdo->beginTransaction();
        try {
            $id = uuid();
            $insert = $pdo->prepare(
                "INSERT INTO users (id, email, username, password_hash, role, teacher_id) VALUES (?, ?, ?, ?, 'teacher', ?)"
            );
            $insert->execute([$id, $email, $username, password_hash($password, PASSWORD_DEFAULT), $id]);
            $school = fetchSchoolState($pdo, true);
            $school['data']['teachers'][] = [
                'id' => $id,
                'name' => $fullName,
                'employeeId' => $employeeId,
                'position' => $position,
                'status' => 'Active',
            ];
            saveSchoolState($pdo, $school['data'], $school['revision']);
            $pdo->commit();
            session_regenerate_id(true);
            $_SESSION['user_id'] = $id;
            rotateCsrfToken();
            $profile = ['id' => $id, 'email' => $email, 'username' => $username, 'role' => 'teacher', 'teacherId' => $id, 'mustChangePassword' => false];
            respond(201, ['profile' => $profile]);
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }
    if ($action === 'logout') {
        requireMethod('POST');
        verifyCsrf();
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => time() - 42000,
                'path' => $params['path'],
                'domain' => $params['domain'],
                'secure' => $params['secure'],
                'httponly' => $params['httponly'],
                'samesite' => 'Strict',
            ]);
        }
        session_destroy();
        session_start();
        rotateCsrfToken();
        respond(200, ['success' => true]);
    }
    if ($action === 'change-password') {
        requireMethod('POST');
        verifyCsrf();
        $user = requireUser();
        if (!$user['mustChangePassword']) {
            throw new ApiError('Password changes are only enabled for temporary passwords.', 403);
        }
        $input = readInput();
        $password = (string)($input['password'] ?? '');
        if (strlen($password) < 12 || strlen($password) > 128) {
            throw new ApiError('Passwords must be 12–128 characters long.');
        }
        $statement = database()->prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?');
        $statement->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        $user['mustChangePassword'] = false;
        rotateCsrfToken();
        respond(200, ['profile' => $user]);
    }
    if ($action === 'state/load') {
        requireMethod('GET');
        $user = requireUser();
        requireReadyAccount($user);
        $school = fetchSchoolState(database());
        respond(200, ['data' => ['data' => loadVisibleState($school['data'], $user), 'revision' => $school['revision']]]);
    }
    if ($action === 'state/save') {
        requireMethod('POST');
        verifyCsrf();
        $user = requireUser();
        requireReadyAccount($user);
        $input = readInput();
        $submitted = validateSchoolData($input['data'] ?? null);
        $expectedRevision = filter_var($input['expectedRevision'] ?? null, FILTER_VALIDATE_INT);
        if ($expectedRevision === false || $expectedRevision < 0) {
            throw new ApiError('The school-record revision is invalid.');
        }
        $pdo = database();
        $pdo->beginTransaction();
        try {
            $stored = fetchSchoolState($pdo, true);
            if ($stored['revision'] !== $expectedRevision) {
                $pdo->rollBack();
                throw new ApiError('School records were changed by another user. Reload the latest records and retry.', 409, 'CONFLICT');
            }
            $next = $user['role'] === 'admin'
                ? $submitted
                : mergeTeacherState($stored['data'], $submitted, $user);
            $revision = saveSchoolState($pdo, $next, $stored['revision']);
            $pdo->commit();
            respond(200, ['revision' => $revision]);
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $error;
        }
    }
    if ($action === 'admin/create-teacher' || $action === 'admin/reset-password') {
        requireMethod('POST');
        verifyCsrf();
        $user = requireUser();
        requireAdmin($user);
        requireReadyAccount($user);
        $input = readInput();
        $pdo = database();
        if ($action === 'admin/create-teacher') {
            $username = strtolower(trim((string)($input['username'] ?? '')));
            $password = (string)($input['password'] ?? '');
            $fullName = trim((string)($input['fullName'] ?? ''));
            $employeeId = trim((string)($input['employeeId'] ?? ''));
            $position = trim((string)($input['position'] ?? ''));
            if (!validUsername($username) || strlen($password) < 12 || strlen($password) > 128 ||
                $fullName === '' || strlen($fullName) > 100 || strlen($employeeId) > 40 || strlen($position) > 80) {
                throw new ApiError('Check the username, temporary password, and teacher details.');
            }
            $pdo->beginTransaction();
            try {
                $id = uuid();
                $insert = $pdo->prepare(
                    "INSERT INTO users (id, username, password_hash, role, teacher_id, must_change_password) VALUES (?, ?, ?, 'teacher', ?, 1)"
                );
                $insert->execute([$id, $username, password_hash($password, PASSWORD_DEFAULT), $id]);
                $school = fetchSchoolState($pdo, true);
                $school['data']['teachers'][] = [
                    'id' => $id,
                    'name' => $fullName,
                    'employeeId' => $employeeId,
                    'position' => $position,
                    'status' => 'Active',
                ];
                $revision = saveSchoolState($pdo, $school['data'], $school['revision']);
                $pdo->commit();
                respond(201, ['success' => true, 'revision' => $revision]);
            } catch (Throwable $error) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $error;
            }
        }
        $teacherId = trim((string)($input['teacherId'] ?? ''));
        $password = (string)($input['password'] ?? '');
        if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i', $teacherId)) {
            throw new ApiError('Select a valid teacher account.');
        }
        if (strlen($password) < 12 || strlen($password) > 128) {
            throw new ApiError('Temporary passwords must be 12–128 characters.');
        }
        $update = $pdo->prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE teacher_id = ? AND role = 'teacher'");
        $update->execute([password_hash($password, PASSWORD_DEFAULT), $teacherId]);
        if ($update->rowCount() !== 1) {
            throw new ApiError('That teacher account could not be found.', 404);
        }
        respond(200, ['success' => true]);
    }
    throw new ApiError('Unknown API operation.', 404);
}

try {
    runApi();
} catch (ApiError $error) {
    respond($error->status, [
        'error' => $error->getMessage(),
        ...($error->errorCode !== '' ? ['code' => $error->errorCode] : []),
    ]);
} catch (PDOException $error) {
    error_log('Teacher Load Manager database operation failed: ' . $error->getMessage());
    $duplicate = $error->getCode() === '23000';
    respond($duplicate ? 409 : 500, [
        'error' => $duplicate ? 'That username or email is already in use.' : 'A database operation failed. Check the XAMPP MySQL service and database setup.',
    ]);
} catch (Throwable $error) {
    error_log('Teacher Load Manager API error: ' . $error->getMessage());
    respond(500, ['error' => 'The local server could not complete the request. Check the PHP error log.']);
}
