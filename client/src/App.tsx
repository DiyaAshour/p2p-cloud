import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Onboarding from "./pages/Onboarding";
import { useEffect, useState } from "react";

const ipc = (window as any).electron?.ipcRenderer;

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/index.html" component={Home} />
      <Route path="/404" component={NotFound} />
      <Route component={Home} />
    </Switch>
  );
}

function BrowserFallback() {
  return (
    <div style={{ padding: 40, color: "white", background: "#0f172a", minHeight: "100vh" }}>
      <h1>P2P Cloud</h1>
      <p>This app is running in the browser without Electron IPC.</p>
      <p>
        Wallet features may still work in the browser, but local node controls,
        onboarding persistence, and system-level storage integration require Electron.
      </p>
    </div>
  );
}

function App() {
  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState(false);
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    const init = async () => {
      if (!ipc) {
        setIsElectron(false);
        setChecked(true);
        return;
      }

      setIsElectron(true);

      try {
        const session = await ipc.invoke("onboarding:read");
        if (session?.wallet && session?.storage) {
          setReady(true);
        }
      } catch (error) {
        console.error("Failed to read onboarding session:", error);
      } finally {
        setChecked(true);
      }
    };

    init();
  }, []);

  if (!checked) return null;

  if (!isElectron) {
    return <BrowserFallback />;
  }

  if (!ready) {
    return <Onboarding onReady={() => setReady(true)} />;
  }

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
