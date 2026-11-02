import { createRoot } from "react-dom/client";
import { DesktopMenuRoot } from "./menu-window";
import "@/styles/globals.css";

// A menu is not a second application: no App, business stores, splash or updater.
document.addEventListener("contextmenu", event => event.preventDefault());
createRoot(document.getElementById("root")!).render(<DesktopMenuRoot />);
