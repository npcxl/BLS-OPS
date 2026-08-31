import ReactDOM from "react-dom/client";
import App from "./App";
import { initTheme } from "@/hooks/use-theme";
import "./styles/globals.css";

initTheme();

/**
 * No StrictMode: in development it double-invokes effects, which would open a
 * real SSH connection, immediately tear it down (`ssh_disconnect`), then open a
 * second one. That makes connect/disconnect/reconnect unreliable and is not a
 * bug worth debugging twice.
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
