# Portada para compartir

`share-cover.svg` es la fuente autocontenida de `apps/web/public/share/cover.png`. Usa el favicon y una sección de la ilustración existente del recorrido, sin controles ni datos de una cuenta. Para modificarla, editar el SVG y renderizarlo a PNG de 1200 x 630 con un conversor SVG compatible; no se requiere otra dependencia en el juego. Se generó con Sharp disponible en el runtime de trabajo y se inspeccionó el PNG final.

Los metadatos estáticos de la portada `apps/web/index.html` y el juego `apps/web/jugar/index.html` usan el origen canónico `https://robotrunner.guilleojeda.com`. La portada se comparte desde `/`, el juego se abre en `/jugar` y la imagen pública está en `/share/cover.png`. La imagen no contiene datos de una cuenta; las tarjetas de resultado usan automáticamente el hostname desde donde se juega.
