import { useEffect, useMemo, useRef, useState } from 'react';
import type { AttemptSummary } from './attempt-api.js';
import { renderResultImage, shareResult, shareText, type ShareResult } from './result-sharing.js';

function canShareFile(file: File): boolean {
  try {
    return (
      typeof navigator.share === 'function' && navigator.canShare?.({ files: [file] }) === true
    );
  } catch {
    return false;
  }
}

function SharePanel({ result, onClose }: { result: ShareResult; onClose: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [image, setImage] = useState<{ url: string; file: File } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [sharing, setSharing] = useState(false);
  const [retry, setRetry] = useState(0);
  const url = new URL('/bienvenida.html', window.location.origin).href;
  const text = shareText(result, url);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    renderResultImage(result, window.location.origin).then(
      (blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({
          url: objectUrl,
          file: new File([blob], 'robot-runner-resultado.png', { type: 'image/png' }),
        });
      },
      () => {
        if (!disposed)
          setError('No se pudo generar la tarjeta. Podés reintentar o copiar el texto.');
      },
    );
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [result, retry]);

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Texto y enlace copiados.');
    } catch {
      setNotice('No se pudo copiar. Seleccioná el texto de abajo y copialo.');
    }
  }

  async function nativeShare() {
    if (!image || sharing) return;
    setSharing(true);
    setNotice('');
    try {
      await navigator.share({ title: 'Robot Runner: A puro prompt', text, files: [image.file] });
      setNotice('Resultado compartido.');
    } catch (failure) {
      if (!(
        (failure instanceof Error || failure instanceof DOMException) &&
        failure.name === 'AbortError'
      )) {
        setNotice('No se pudo compartir. Podés descargar la imagen y copiar el texto.');
      }
    } finally {
      setSharing(false);
    }
  }

  return (
    <section className="result-share-panel" aria-labelledby="result-share-title">
      <div className="result-share-heading">
        <h4 id="result-share-title" ref={heading} tabIndex={-1}>
          Compartir resultado
        </h4>
        <button className="secondary-button" type="button" onClick={onClose} disabled={sharing}>
          Cerrar
        </button>
      </div>
      <p>
        La tarjeta incluye sólo tu resultado. Tus instrucciones y los datos de tu cuenta quedan
        fuera.
      </p>
      {image ? (
        <img
          className="result-share-image"
          src={image.url}
          alt={text.split('\n')[0]}
          width="1200"
          height={result.kind === 'victory' ? 720 : 840}
        />
      ) : error ? (
        <div>
          <p role="alert">{error}</p>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setError(null);
              setRetry(retry + 1);
            }}
          >
            Reintentar tarjeta
          </button>
        </div>
      ) : (
        <p role="status">Preparando tarjeta…</p>
      )}
      <div className="attempt-result-actions">
        {image && (
          <a
            className="secondary-button result-share-download"
            href={image.url}
            download={image.file.name}
          >
            Descargar imagen
          </a>
        )}
        <button className="secondary-button" type="button" onClick={() => void copyText()}>
          Copiar texto y enlace
        </button>
        {image && canShareFile(image.file) && (
          <button
            className="primary-button"
            type="button"
            disabled={sharing}
            onClick={() => void nativeShare()}
          >
            {sharing ? 'Compartiendo…' : 'Compartir imagen y texto'}
          </button>
        )}
      </div>
      <label className="result-share-text-label" htmlFor="result-share-text">
        Texto para compartir
      </label>
      <textarea
        id="result-share-text"
        className="result-share-text"
        readOnly
        value={text}
        rows={4}
      />
      <p>
        El enlace abre la presentación del juego. Para mostrar tu resultado, adjuntá también la
        imagen.
      </p>
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}

export function ResultSharing({
  attempt,
  disabled,
}: {
  attempt: AttemptSummary;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Keep this model stable while the panel renders its own asynchronous states.
  const result = useMemo(() => shareResult(attempt), [attempt]);
  if (!result) return null;
  return (
    <div className="result-sharing">
      <button
        ref={trigger}
        className="secondary-button"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Compartir resultado
      </button>
      {open && (
        <SharePanel
          key={JSON.stringify(result)}
          result={result}
          onClose={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        />
      )}
    </div>
  );
}
