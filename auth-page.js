import { firebaseConfig, isFirebaseConfigured } from "./firebase-config.js";

const pageType = document.body.dataset.accountPage;
const errorOutput = document.querySelector("#account-error");
const setupNote = document.querySelector("#firebase-setup-note");
const submitButton = document.querySelector("#account-submit");
const resetButton = document.querySelector("#reset-password");
const successOutput = document.querySelector("#account-message");

let firebase = null;
let currentUser = null;

const messages = {
  "auth/email-already-in-use": "This email already has an account. Sign in instead.",
  "auth/invalid-email": "Enter a valid email address.",
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/weak-password": "Choose a password with at least 6 characters.",
  "auth/user-not-found": "No account was found for that email address.",
  "auth/operation-not-allowed": "Email/Password sign-in is not enabled in Firebase Authentication.",
  "auth/too-many-requests": "Too many attempts. Wait a little and try again.",
  "auth/network-request-failed": "Firebase needs an internet connection. Your local tracker remains available."
};

function showError(message) {
  errorOutput.textContent = message;
  errorOutput.classList.remove("hidden");
}

function errorMessage(error) {
  return messages[error.code] || `Firebase request failed: ${error.message}`;
}

async function initializeFirebase() {
  if (!isFirebaseConfigured) {
    setupNote.textContent = "Firebase Web App config is missing. Add the values in firebase-config.js and enable Email/Password sign-in in Firebase Console.";
    submitButton.disabled = true;
    if (resetButton) resetButton.disabled = true;
    return false;
  }
  try {
    const [appSdk, authSdk, databaseSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js")
    ]);
    const app = appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(firebaseConfig);
    const auth = authSdk.getAuth(app);
    const database = databaseSdk.getDatabase(app);
    firebase = { authSdk, databaseSdk, auth, database };
    setupNote.textContent = "Connected to Firebase. Account details are protected by your Firebase Authentication and Database rules.";
    submitButton.disabled = false;
    if (resetButton) resetButton.disabled = false;
    return true;
  } catch (error) {
    console.error("Firebase account page initialization failed.", error);
    setupNote.textContent = "Could not connect to Firebase. Check your internet connection and Web App config.";
    submitButton.disabled = true;
    if (resetButton) resetButton.disabled = true;
    return false;
  }
}

function renderProfile(user) {
  currentUser = user;
  const displayName = user.displayName || "Daybook user";
  document.querySelector("#profile-display-name").textContent = displayName;
  document.querySelector("#profile-email").textContent = user.email || "";
  document.querySelector("#profile-name").value = user.displayName || "";
  document.querySelector("#profile-avatar").textContent = displayName.trim().charAt(0).toUpperCase() || "D";
  document.querySelector("#profile-uid").textContent = user.uid;
  document.querySelector("#profile-created").textContent = user.metadata.creationTime
    ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(user.metadata.creationTime))
    : "—";
}

async function submitLogin(event) {
  event.preventDefault();
  errorOutput.classList.add("hidden");
  if (successOutput) successOutput.classList.add("hidden");
  if (!firebase && !await initializeFirebase()) return;
  submitButton.disabled = true;
  try {
    await firebase.authSdk.signInWithEmailAndPassword(
      firebase.auth,
      document.querySelector("#login-email").value.trim(),
      document.querySelector("#login-password").value
    );
    window.location.assign("index.html");
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    submitButton.disabled = false;
  }
}

async function resetPassword() {
  errorOutput.classList.add("hidden");
  successOutput.classList.add("hidden");
  const email = document.querySelector("#login-email").value.trim();
  if (!email) {
    showError("Enter your email address above first.");
    return;
  }
  if (!firebase && !await initializeFirebase()) return;

  resetButton.disabled = true;
  try {
    await firebase.authSdk.sendPasswordResetEmail(firebase.auth, email);
    successOutput.textContent = `If an account exists for ${email}, Firebase will send a password reset email. Check your inbox and spam folder.`;
    successOutput.classList.remove("hidden");
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    resetButton.disabled = false;
  }
}

async function submitRegistration(event) {
  event.preventDefault();
  errorOutput.classList.add("hidden");
  if (!firebase && !await initializeFirebase()) return;
  submitButton.disabled = true;
  try {
    const name = document.querySelector("#register-name").value.trim();
    const credential = await firebase.authSdk.createUserWithEmailAndPassword(
      firebase.auth,
      document.querySelector("#register-email").value.trim(),
      document.querySelector("#register-password").value
    );
    await firebase.authSdk.updateProfile(credential.user, { displayName: name });
    try {
      await firebase.databaseSdk.set(
        firebase.databaseSdk.ref(firebase.database, `users/${credential.user.uid}/profile`),
        { displayName: name, email: credential.user.email, updatedAt: Date.now() }
      );
      window.location.assign("index.html");
    } catch (error) {
      console.error("Account was created, but the database profile could not be saved.", error);
      sessionStorage.setItem("daybook-profile-warning", "Account created. The display name is saved, but the database profile could not sync. Check your Realtime Database rules.");
      window.location.assign("profile.html");
    }
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    submitButton.disabled = false;
  }
}

async function loadProfile() {
  if (!firebase && !await initializeFirebase()) {
    document.querySelector("#profile-display-name").textContent = "Firebase setup required";
    document.querySelector("#profile-form").querySelectorAll("input, button").forEach((control) => {
      control.disabled = true;
    });
    return;
  }
  firebase.authSdk.onAuthStateChanged(firebase.auth, async (user) => {
    if (!user) {
      window.location.replace("login.html");
      return;
    }
    document.querySelector("#profile-sign-out").disabled = false;
    renderProfile(user);
    const profileWarning = sessionStorage.getItem("daybook-profile-warning");
    if (profileWarning) {
      setupNote.textContent = profileWarning;
      sessionStorage.removeItem("daybook-profile-warning");
    }
    try {
      const profileRef = firebase.databaseSdk.ref(firebase.database, `users/${user.uid}/profile`);
      const profile = await firebase.databaseSdk.get(profileRef);
      if (profile.exists() && profile.val().displayName && profile.val().displayName !== user.displayName) {
        await firebase.authSdk.updateProfile(user, { displayName: profile.val().displayName });
        renderProfile(user);
      }
    } catch (error) {
      console.error("Could not load the saved profile record.", error);
      setupNote.textContent = "Profile loaded from Firebase Authentication; the optional database profile could not be read. Check your Database rules.";
    }
  });
}

if (pageType === "login") {
  document.querySelector("#login-form").addEventListener("submit", submitLogin);
  resetButton.addEventListener("click", resetPassword);
} else if (pageType === "register") {
  document.querySelector("#register-form").addEventListener("submit", submitRegistration);
} else if (pageType === "profile") {
  document.querySelector("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    errorOutput.classList.add("hidden");
    if (!currentUser || !firebase) return;
    submitButton.disabled = true;
    const name = document.querySelector("#profile-name").value.trim();
    try {
      if (!name) throw new Error("Enter a display name.");
      await firebase.authSdk.updateProfile(currentUser, { displayName: name });
      renderProfile(currentUser);
      try {
        await firebase.databaseSdk.set(
          firebase.databaseSdk.ref(firebase.database, `users/${currentUser.uid}/profile`),
          { displayName: name, email: currentUser.email, updatedAt: Date.now() }
        );
        setupNote.textContent = "Profile saved to Firebase.";
      } catch (error) {
        console.error("Display name updated, but database profile sync failed.", error);
        setupNote.textContent = "Display name updated in Firebase Authentication, but database profile sync failed. Check your Realtime Database rules.";
      }
    } catch (error) {
      showError(errorMessage(error));
    } finally {
      submitButton.disabled = false;
    }
  });
  document.querySelector("#profile-sign-out").addEventListener("click", async () => {
    if (!firebase) return;
    try {
      await firebase.authSdk.signOut(firebase.auth);
      window.location.assign("login.html");
    } catch (error) {
      showError(errorMessage(error));
    }
  });
  loadProfile();
}

if (pageType !== "profile") initializeFirebase();
