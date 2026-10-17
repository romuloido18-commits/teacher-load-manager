# Teacher Load Manager

A browser-based school personnel and teaching-load tracker. Add teacher profiles, record learning areas and class assignments with configurable groups, periods 1-7, weekdays, and weekly minutes. Turn on automatic recording in **Groups & periods** to create an assignment for each configured group and period. Review workload totals, print the overview, or export the assignment list as CSV. The app has no server or sign-in; each browser stores its own records.

Teaching loads are automatically ordered by teacher, earliest selected weekday, and scheduled start time.

The local operator can manage teacher profiles and assignments from the directory and **Preview teacher loads**. The app is intended for single-browser use, not simultaneous multi-user editing.

Use **Substitution plans** to manage staff coverage. Mark the teacher **On leave**, then create a plan by selecting available substitutes and loads to cover. The app checks group, period, time, weekday, and overlapping schedules. Print a draft or open a saved plan's print preview. Plans are stored in this browser.

The interface uses Arial Narrow at 16px throughout.

Open **Settings** to configure school branding, including the school name, address, School ID, logo, and principal's name and designation. The logo must be a PNG, JPG, WebP, or GIF image no larger than 1 MB. Branding is stored in this browser and appears in the app and printed reports.

## Local use

Open `index.html` in a modern browser, or serve `index.html`, `app.js`, and `styles.css` from a static web host. To use it from Google Sites, host those files separately and embed their public URL with **Insert → Embed → URL**. Google Sites cannot host the app files or run a PHP/MySQL backend. Do not include PHP or database configuration files in the static deployment. A static host only serves the app; it does not make records shared between users.

## Records and privacy

Teacher profiles, teaching loads, substitution plans, leave records, and settings are saved in the browser's local storage. They stay in that browser and do not sync across devices or users. Anyone using that browser or embedded app can view and change the records; there is no sign-in or access control. Do not use this version for sensitive school records unless that storage and access model is approved.

Use **Download full backup** regularly to save all records and settings as JSON. **Restore from backup** replaces the current records in this browser. **Export teaching-load CSV** exports assignments only. Clearing browser data can erase local records.

Existing records in the XAMPP MySQL database are not loaded by this version and are not deleted; export or migrate them before switching. Older records previously saved in this browser are migrated automatically when the app first opens.

The app does not enforce a weekly workload limit. Confirm applicable school and division policies before using the recorded minutes for official reporting.
