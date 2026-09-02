import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Workbench } from "@/workbench/Workbench";

/** App root — spec §72. */
export default function App() {
  return (
    <ErrorBoundary>
      <Workbench />
    </ErrorBoundary>
  );
}
