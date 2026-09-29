import { useLocation } from "react-router-dom";
import { useAppVersion } from "../hooks/useAppVersion";

/*
==================================================
AppFooter
==================================================
"VoxSuite v<frontend>-<backend>" centred at the bottom of every page
(moved out of the header, which now shows only the logo). The login
page shows the version inside its own card, so it's skipped there.
Sits at the bottom of the window on short pages (see #root in
theme.css) and after the content on long ones.
==================================================
*/
export default function AppFooter() {
  const appVersion = useAppVersion();
  const { pathname } = useLocation();
  if (!appVersion || pathname === "/login") return null;
  return <footer className="app-footer">VoxSuite v{appVersion}</footer>;
}
