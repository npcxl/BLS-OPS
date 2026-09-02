import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary. Catches render/runtime errors from any descendant
 * so a single component crash (e.g. a stale HMR module, or a bad prop) does not
 * blank the whole app. Shows the message with a copy button and a retry,
 * instead of React's plain dev-only overlay.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  private handleRetry = () => this.setState({ error: null });

  private handleCopy = () => {
    void navigator.clipboard.writeText(
      `${this.state.error?.message ?? "未知错误"}\n\n${this.state.error?.stack ?? ""}`,
    );
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-app p-8 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/15 text-danger">
          <span className="text-lg">!</span>
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="text-15 font-semibold text-fg">界面出错了</h1>
          <p className="max-w-md text-12 text-fg-subtle">
            某个组件在运行时崩溃。你可以重试，或复制错误信息反馈给开发者。
          </p>
        </div>
        <pre className="max-h-48 w-full max-w-lg overflow-auto rounded-[8px] border border-line bg-surface-2 p-3 text-left text-11 text-danger">
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ""}
        </pre>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="flex h-8 items-center rounded-[8px] bg-accent px-4 text-12 font-medium text-white hover:opacity-90"
          >
            重试
          </button>
          <button
            type="button"
            onClick={this.handleCopy}
            className="flex h-8 items-center rounded-[8px] border border-line bg-surface-1 px-4 text-12 text-fg hover:bg-surface-2"
          >
            复制错误信息
          </button>
        </div>
      </div>
    );
  }
}
