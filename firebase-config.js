export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  databaseURL: "https://daily-habit-and-food-expense-default-rtdb.firebaseio.com",
  projectId: "",
  appId: ""
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.projectId &&
  firebaseConfig.appId &&
  firebaseConfig.databaseURL
);
