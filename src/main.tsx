import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

// No StrictMode: its double-invoked effects would open and immediately tear
// down a real SSH connection on every mount.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
