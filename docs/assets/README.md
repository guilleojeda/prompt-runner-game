# Portada para compartir

`share-cover.svg` es la fuente autocontenida de `apps/web/public/share/cover.png`. Usa el favicon y una sección de la ilustración existente del recorrido, sin controles ni datos de una cuenta. Para modificarla, editar el SVG y renderizarlo a PNG de 1200 x 630 con un conversor SVG compatible; no se requiere otra dependencia en el juego. Se generó con Sharp disponible en el runtime de trabajo y se inspeccionó el PNG final.

Los metadatos estáticos de `apps/web/index.html` y `apps/web/bienvenida.html` usan el origen público de CloudFront mientras sea el acceso disponible. Al conectar el subdominio elegido, actualizar en ambas páginas `og:url`, `og:image` y `twitter:image` al nuevo origen. La imagen no incluye un dominio pendiente de conexión y las tarjetas de resultado usan automáticamente el hostname desde donde se juega.
