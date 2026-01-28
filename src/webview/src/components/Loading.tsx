interface LoadingProps {
  message: string;
}

export function Loading({ message }: LoadingProps) {
  return (
    <div className="loading-container">
      <div className="spinner" />
      <div className="loading-message">{message}</div>
    </div>
  );
}
