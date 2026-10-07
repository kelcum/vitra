import { listen } from "@tauri-apps/api/event";
import { Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage, parseError } from "../../lib/api";
import { toast, useDialogs } from "../../lib/store";
import type { DeviceCodeInfo } from "../../lib/types";
import { Button } from "../ui/Button";
import { Notice, Spinner } from "../ui/Feedback";
import { Modal } from "../ui/Overlay";

export function SignInDialog() {
  const open = useDialogs((s) => s.signIn);
  const set = useDialogs((s) => s.set);
  const [code, setCode] = useState<DeviceCodeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [remaining, setRemaining] = useState(0);

  const start = async () => {
    setError(null);
    setCode(null);
    setStarting(true);
    try {
      const info = await api.beginSignIn();
      setCode(info);
      setRemaining(info.expiresIn);
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!open) {
      setCode(null);
      setError(null);
      return;
    }
    start();
    const un = listen<string>("auth://error", (e) => {
      setError(e.payload);
      setCode(null);
    });
    return () => {
      un.then((f) => f());
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!code) return;
    const t = window.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => window.clearInterval(t);
  }, [code]);

  const close = () => {
    api.cancelSignIn();
    set({ signIn: false });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      icon={<ShieldCheck />}
      title="Sign in with Microsoft"
      description="You sign in on Microsoft's own website. Vitra never sees or stores your password."
    >
      {error ? (
        <div className="col" style={{ gap: 14 }}>
          <Notice tone="danger">{error}</Notice>
          <div className="row">
            <Button variant="primary" onClick={start} loading={starting}>
              Try again
            </Button>
          </div>
        </div>
      ) : !code ? (
        <div className="row" style={{ padding: "24px 0", justifyContent: "center", gap: 12 }}>
          <Spinner /> <span className="t-muted">Contacting Microsoft…</span>
        </div>
      ) : (
        <div className="col" style={{ gap: 18, alignItems: "center", padding: "6px 0 10px" }}>
          <div className="t-muted" style={{ textAlign: "center" }}>
            Open the Microsoft page and enter this code:
          </div>
          <button
            className="device-code"
            onClick={() => {
              navigator.clipboard.writeText(code.userCode);
              toast.success("Code copied");
            }}
            data-tip="Click to copy"
          >
            {code.userCode}
            <Copy />
          </button>
          <Button
            variant="primary"
            size="lg"
            icon={<ExternalLink />}
            onClick={() => {
              navigator.clipboard.writeText(code.userCode).catch(() => {});
              api.openUrl(code.verificationUri).catch((e) => toast.error("Couldn't open the browser", errorMessage(e)));
            }}
          >
            Copy code & open Microsoft
          </Button>
          <div className="row t-faint" style={{ fontSize: 12.5 }}>
            <Spinner size={14} />
            Waiting for you to finish… code expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
          </div>
        </div>
      )}
    </Modal>
  );
}
