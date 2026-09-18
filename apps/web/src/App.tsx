export function App() {
  return (
    <main className="shell">
      <p className="eyebrow">Taller de agentes</p>
      <h1>Enseñale a jugar al robot</h1>
      <p className="intro">
        Configurá sus instrucciones y observá cómo decide recorrer el mundo, una decisión a la vez.
      </p>
      <section className="card" aria-labelledby="estado-titulo">
        <div className="robot" aria-hidden="true">
          <span className="robot-eye" />
          <span className="robot-eye" />
        </div>
        <div>
          <h2 id="estado-titulo">La base está lista</h2>
          <p>El espacio de juego se está preparando para tu primer robot.</p>
        </div>
      </section>
      <p className="status" role="status">
        Próximamente: configurar y probar.
      </p>
    </main>
  );
}
