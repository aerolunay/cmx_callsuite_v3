import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./context/AuthContext.jsx";
import "./styles/theme.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {/* No web phone / dialer socket any more: calls are handled only
            in the CMX CallSuite Desktop app. */}
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
