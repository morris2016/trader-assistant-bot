import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><AuthGate><App /></AuthGate></React.StrictMode>);
