# Teacher Load Manager

A lightweight, browser-based school personnel and teaching-load tracker. Add teacher profiles, record learning areas and class assignments with configurable groups, periods 1–7, weekdays, and weekly minutes. Turn on automatic recording in the sidebar's **Groups & periods** settings to create one assignment for every configured group in each period; leave **Period and time** unselected to create all assignments, or choose an option to create a single assignment. Selected weekdays and weekly minutes apply to each generated assignment, and configured group-and-period times fill schedules automatically. The **Period and time** dropdown lists the configured schedules for every group and period; choosing an option synchronizes the group and period fields. Configure separate start and end times for every group and period in **Groups & periods**. Review workload totals, print the overview, or export the assignment list as CSV.

Teaching loads are automatically ordered by teacher, earliest selected weekday, and scheduled start time.

Admins can edit or delete assignments from the **Assignment directory**. Teachers can edit or delete loads only from their own profile. The directory and **Preview teacher loads** list show labeled **Edit** and **Delete** buttons for loads the signed-in account can manage.

Use **Substitution plans** in the sidebar to apply for leave or manage staff coverage. Teachers can submit a leave application with a start and end date; the admin can approve or reject it. Approval marks the teacher **On leave**, after which the teacher can submit a coverage proposal. Teachers can edit or delete their own pending coverage proposals until the admin reviews them. The admin reviews those proposals separately. The admin should update the teacher's status when the leave period is over. Admins can also create substitution plans directly. Filter assignments by the configured group (such as Morning shift or Afternoon shift) and Period 1–7; with **All periods** selected, the available-substitute list includes teachers free for at least one matching load, and selecting a specific period or load narrows it to that time. Displayed times follow the current Groups & periods settings; loads that conflict with the substitute's existing teaching or overlapping substitution-plan schedule are unavailable. Use **Print preview** on a saved plan's row to inspect its details, then select **Print this plan** to open the browser print preview. Edit or delete a saved plan from its row as well. **Print plan** prints a draft before saving. Records are stored in the local MySQL database managed by XAMPP.

The interface uses Arial Narrow at 16px throughout.

Open **Settings** to configure school branding, including the school name, address, School ID, logo, and principal's name and designation. The logo must be a PNG, JPG, WebP, or GIF image no larger than 1 MB. Branding is stored with the school's shared records and appears in the app and printed reports.

## Sign in

Teachers can create an account with an email address, username, and password. Their profile is added to the MySQL school records automatically. They sign in with their email address or username. Teachers can add, edit, or delete loads only for their own profile, apply for leave, and submit a substitution proposal after the admin approves their leave application. Leave applications and coverage proposals remain pending until the admin reviews them. The admin retains final control of schoolwide records. The application does not record sign-in history.

Admins can use **Teachers Account → Add user account** to create an individual teacher login. Enter the teacher's name, username, and a temporary password of at least 12 characters; no email address is needed. The teacher signs in with that username and must replace the temporary password at first sign-in before accessing school records. Give the username and temporary password to the teacher through a private channel. Admin-created accounts have no email address and cannot use email-based password recovery. Never create shared accounts or grant teacher accounts the admin role.

Admins can reset an existing teacher password from the teacher directory using the reset-password action. Enter and confirm a temporary password of at least 12 characters; the teacher must change it at next sign-in. Share temporary passwords privately.

## Install with XAMPP

This version uses PHP sessions and MySQL through XAMPP; it no longer connects to Supabase. The database and user accounts are local to the XAMPP server.

1. Install XAMPP with Apache, MySQL, PHP, and the PHP PDO MySQL extension.
2. Copy the project folder into XAMPP's `htdocs`, for example `C:\xampp\htdocs\teacher-load-manager`.
3. In the XAMPP Control Panel, start **Apache** and **MySQL**.
4. Open phpMyAdmin at `http://localhost/phpmyadmin`, select **Import**, and import `database-schema.sql`. This creates the `teacher_load_manager` database and its tables.
5. Copy `db-config.example.php` to `db-config.php` and edit the values for your local database. Create a dedicated MySQL user with a strong password; do not use the default `root` account on a network-accessible server.
6. Open `http://localhost/teacher-load-manager/` (use the folder name you chose). Do not open `index.html` directly; PHP and the database API must be served by Apache.
7. Create the first account using **Create a teacher account**. It starts as a teacher. In phpMyAdmin, run `UPDATE users SET role = 'admin' WHERE username = 'YOUR_USERNAME';`, replacing the username. Sign out and back in for the admin role to take effect.
8. Sign in as admin and use **Teachers Account → Add user account** to create teacher logins. Share temporary passwords privately.

Do not expose phpMyAdmin or MySQL to the internet, port-forward this XAMPP server, or use the default blank-password root account on a network-accessible server. For school-network access, install and secure XAMPP on a designated server, use a dedicated MySQL account, configure Apache/firewall access deliberately, and keep this database/API behind the school network. The browser connects to the PHP API on the same host; MySQL credentials remain in PHP and are not sent to the browser.

## Records and privacy

Teacher accounts and school records are stored in the XAMPP server's MySQL database. The public source repository is for source code and documentation only; never upload school records, database backups, exports, credentials, or `db-config.php`. The repository's `.gitignore` excludes common local configuration and data files, but check every file before publishing. Use **Export CSV** to download assignment records for backup or further processing. Existing Supabase data and accounts are not automatically copied to XAMPP; they remain in the original Supabase project. The **Settings → Import records from this browser** tool imports only older browser-local school records and does not import passwords or account logins. Back up data before importing.

The app does not enforce a weekly workload limit. Confirm applicable school and division policies before using the recorded minutes for official reporting.
