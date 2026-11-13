# Daybook Habit & Food Expense Tracker

## Open the app

Double-click `start.bat`. It starts the local server and opens `http://localhost:8080`. The home page offers sign-in, registration, and a **Continue in local mode** option for opening the tracker without an account. Keep the server running while using the app. Run `start.bat` again whenever you want to open it later.

After the first successful load, the app shell is cached for offline use. Your local-mode habits, expenses, and budgets are stored in that browser on that device. Browser local storage is not a substitute for a backup.

## Firebase login and sync

Firebase account registration and cloud sync are prepared but remain inactive until the Firebase Web App config is added:

1. In Firebase Console, open **Project settings → General → Your apps**. Register a Web app if you do not already have one.
2. Copy the browser config values into `firebase-config.js`: `apiKey`, `authDomain`, `projectId`, and `appId`. Keep the existing Realtime Database URL.
3. In **Authentication → Sign-in method**, enable **Email/Password**.
4. In **Realtime Database → Rules**, publish rules like these so each signed-in user can read and write only their own record:

```json
{
  "rules": {
    "users": {
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid"
      }
    }
  }
}
```

The browser config is intended to be public; the database rules enforce access. Never put a Firebase service-account key or private key in this app. Test the rules in Firebase before using real personal data.

When signed in, the app keeps a local copy for offline use and syncs that user's data to `users/{uid}/tracker` when online. Local guest data is kept separately from signed-in account data.

The app has separate `login.html`, `register.html`, and `profile.html` pages. Registration stores the display name in Firebase Authentication and that user's profile record in `users/{uid}/profile`. On the sign-in page, **Forgot password?** sends a password-reset email to the address entered in the email field; the reset link is handled by Firebase. The app never saves the password itself. This requires the Firebase Web App config and Email/Password sign-in to be enabled.

## Features

- Daily habit check-ins, streak counts, and earned badges
- Habit categories with monthly check-in analysis
- Food expense entries with categories and monthly totals
- Monthly budgets with 80% and 100% alerts
- A budget-pace score, category breakdown, month-end estimate, and monthly summary
- Weekly food-spending and habit check-in report, compared with the previous week
- A cautious habit/spending association view based only on overlapping logged days
- Monthly calendar navigation and date selection
- Local-first storage and an offline app shell
