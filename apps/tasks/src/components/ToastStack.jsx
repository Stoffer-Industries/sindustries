import { Toast, ToastViewport } from '@sindustries/ui/react';

export function ToastStack({ toasts }) {
  return (
    <ToastViewport aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <Toast key={toast.id} type={toast.type} className={`toast toast-${toast.type}`}>
          {toast.message}
        </Toast>
      ))}
    </ToastViewport>
  );
}
