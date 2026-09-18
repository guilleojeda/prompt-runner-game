# Enseñale a jugar al robot virtual

Juego educativo de AWS User Group AI Argentina. El participante configura las habilidades e instrucciones de un agente real y pulsa Probar. La interfaz bloquea la edición mientras se calcula el intento; después reproduce una animación si estaba habilitada y muestra el resultado. Se juega colaborativamente en una pantalla durante el booth de AWS en Nerdearla y después individualmente por web.

**Estado del proyecto:** entrada React mínima y circuito de publicación implementados y verificables localmente. La preparación de AWS y el primer despliegue todavía requieren credenciales temporales vigentes de la cuenta de destino. La página inicial no permite registrarse ni jugar. Las capacidades del juego descritas a continuación siguen siendo la especificación objetivo. El nombre del juego es provisional.

## Desarrollo local

Usar la versión de Node indicada en `.nvmrc` y npm. Desde la raíz:

```sh
npm ci
npm run dev
```

La URL local aparece en la salida de Vite. Para ejecutar los mismos controles que GitHub Actions, sin credenciales AWS:

```sh
npm run check
```

El comando verifica formato, lint, tipos, tests de infraestructura, build y síntesis CDK. No llama a modelos ni necesita servicios de backend. `apps/web/` contiene la web y `infra/` la infraestructura. El lockfile fija las versiones instaladas; `.work/` conserva evidencia local y está excluido de Git.

## Publicación

Los pull requests ejecutan los checks sin credenciales de despliegue. Después de integrar a `main`, GitHub Actions vuelve a verificar y publica mediante CDK con credenciales temporales OIDC. Hay un único ambiente, en la cuenta AWS `387483252302`, región `us-east-1`; las actualizaciones afectan la URL pública.

El frontend se sirve por HTTPS desde CloudFront, con un origen S3 privado y OAC. La metadata del build permite contrastar la revisión publicada con el commit y el run de Actions, sin mostrarla en la pantalla del juego. La preparación inicial y la operación se documentan en [acceso y entrega](docs/architecture/acceso-y-entrega.md).

## Documentación del producto

La especificación vigente se organiza por responsabilidad. Incluye las decisiones confirmadas y distingue las preferencias, los defaults propuestos y lo que sigue por resolver.

| Documento | Qué define |
|---|---|
| [Experiencia y alcance](docs/intent/experiencia.md) | Propósito, participación, interfaz y alcance de la primera versión. |
| [Reglas del juego](docs/intent/juego.md) | Recorrido, reloj, acciones, obstáculos, objetos, salida y niveles. |
| [Contrato del agente](docs/intent/agente.md) | Información permitida, herramientas, instrucciones y configuración. |
| [Intentos y reproducción](docs/intent/intentos.md) | Ejecución, registro, persistencia y animación fiel. |
| [Consumo y puntuación](docs/intent/consumo-y-puntaje.md) | Tokens reales, costo, fórmula de puntos y comparación de resultados. |
| [Plataforma y operación](docs/intent/plataforma.md) | Cuentas, cuota, capacidad, tecnologías, AWS y entrega automática. |

Cada documento describe el comportamiento solicitado y las comprobaciones pertinentes. No afirma que ese comportamiento ya esté implementado o verificado. Los detalles técnicos pendientes no son decisiones aprobadas por aparecer enumerados.

## Referencias técnicas

Las consultas de servicios se conservan por tema, con fecha, fuentes y límites de evidencia. Describen capacidades disponibles; no reemplazan la especificación ni aprueban una arquitectura.

| Referencia | Contenido |
|---|---|
| [AgentCore](docs/reference/agentcore.md) | Runtime con Strands, controles de memoria/contexto, TypeScript, tareas asíncronas y cuotas. |
| [Bedrock](docs/reference/bedrock.md) | Sonnet 5/4.6, APIs, selección de herramientas, tokens, caché y tarifas. |
| [Identidad y correo](docs/reference/identidad.md) | Cognito, verificación de email, OTP, SES, interfaces y costos. |
| [Datos y entrega](docs/reference/datos-y-entrega.md) | DynamoDB, S3, Lambda/API Gateway, CDK, publicación web y GitHub Actions. |
| [Cuenta AWS](docs/reference/cuenta-aws.md) | Resultados de consultas de lectura al entorno y lo que esas consultas no verifican. |

## Arquitectura

**Decisión final de ejecución:** AgentCore Runtime con Strands TypeScript y el proveedor nativo de Amazon Bedrock, inicialmente Sonnet 5 global mediante Converse sin streaming. No se usa Mantle. El registro conserva snapshots y resoluciones, y React/SVG compone la animación a partir de esos datos. El flujo acordado es Probar → cálculo con controles bloqueados → animación opcional a velocidad fija, hacia adelante y sin controles → resultado. La implementación está pendiente.

Están aprobados el contrato de registro, el reproductor, DynamoDB on-demand con S3 privado para cuerpos de inferencia, un único ambiente, la política diaria de cuota y Cognito Essentials con Managed Login. La primera versión usa el correo predeterminado de Cognito, aceptando sus 50 emails diarios y mensajes estándar; SES se incorporará en una fase posterior sobre el mismo user pool. El frontend React estático se publicará en S3 privado mediante CloudFront con Origin Access Control, usando CDK y GitHub Actions.

| Documento | Contenido |
|---|---|
| [Ejecución del juego y agente](docs/architecture/ejecucion.md) | Decisión Runtime/Strands/Bedrock, flujo de pantalla, continuidad, concurrencia y fallos. |
| [Persistencia y cuota](docs/architecture/datos.md) | DynamoDB/S3, registro completo, historial y política diaria aprobados. |
| [Registro de ejecución](docs/architecture/registro-de-ejecucion.md) | Snapshots, acciones y resultados, fases, cierre y datos necesarios para reproducir. |
| [Animación](docs/architecture/animacion.md) | Sprites por capas, clips y reacciones, reproducción continua a velocidad fija, compatibilidad y extensión. |
| [Acceso y entrega](docs/architecture/acceso-y-entrega.md) | Cognito inicialmente, SES posterior, publicación en S3 privado con CloudFront, un ambiente y CI/CD automático. |

## Cómo mantener esta documentación

Actualizar el documento que corresponde cuando se acuerda un cambio de comportamiento o una restricción. Enlazar otras áreas cuando haga falta, sin mantener copias completas de la misma regla. Al implementar, documentar allí los detalles configurables elegidos y el fundamento de las limitaciones importantes; agregar las instrucciones de ejecución y operación cuando existan comandos y recursos reales.

Los documentos de `.work/` organizan objetivo, investigación y diseño vigentes. Referencian esta especificación y no son el único lugar donde se documentan decisiones. Conservar únicamente decisiones finales, puntos realmente pendientes y fundamentos técnicos útiles; no guardar cronologías de propuestas, conversaciones o revisiones.

[idea-inicial.md](idea-inicial.md) se conserva como antecedente de la propuesta. Sus decisiones abiertas y exclusiones antiguas no reemplazan esta especificación vigente. No es necesario leerlo para entender los requisitos actuales.
