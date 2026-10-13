# MagicPnP

Aplicación para importar un pedido XML de MPC Fill, revisar los slots y preparar un PDF A4 de cartas a doble cara para la ficha general de barajas de Copistería Soriano.

> **Estado: primera versión funcional, no validada aún para un pedido real.** Falta contrastar el parser y las descargas con un XML auténtico de MPC Fill y verificar el espejo dúplex con una hoja física o con Soriano. La aplicación y sus reportes muestran ese estado sin etiquetar el PDF como listo para imprenta.

## Funciones disponibles

- Importa `fronts`, `backs`, `cardback`, `slot`/`slots`, `id`, `name`, `query` y `details.quantity`.
- Expande grupos de slots en orden físico, conserva huecos y duplicados, y bloquea conflictos de artes.
- Descarga referencias de Google Drive usando un host fijo y una clave configurada por quien despliega la API. Si falla o no se configura, permite reemplazar cada imagen con un archivo local.
- Muestra galería, resolución efectiva, reversos específicos, reverso común y vista previa A4.
- Genera páginas intercaladas de anverso/reverso con corte nominal de 63 × 88 mm, sangrado configurable de 3, 2 o 0 mm y marcas de corte opcionales.
- Refleja posiciones de reverso horizontal o vertical. El valor inicial es «ninguno» hasta completar una prueba dúplex real.
- Descarga el PDF y un reporte JSON. Las imágenes inferiores a 300 ppp requieren confirmación explícita.
- No usa cuentas ni base de datos. Los proyectos y artes viven en memoria y se eliminan al cerrar la sesión o tras dos horas de inactividad.

## Requisitos

- Node.js 24 LTS y npm.
- Para contenedores: Docker Compose.

## Desarrollo local

```sh
npm install
npm test
npm run build
```

En dos terminales:

```sh
npm run dev:api
```

```sh
npm run dev:web
```

Abre `http://localhost:4200`. Angular reenvía `/api` a `http://127.0.0.1:3000` durante el desarrollo.

La descarga desde Drive es opcional. Para habilitar el intento de descarga de imágenes públicas, configura `GOOGLE_DRIVE_API_KEY` **solo en el servidor** antes de iniciar la API:

```sh
GOOGLE_DRIVE_API_KEY='tu-clave' npm run dev:api
```

El backend llama a la API oficial de Drive v3 `files.get?alt=media`. No solicita ni elude acceso a archivos privados. Google puede requerir permisos, una clave de recurso u OAuth y también puede limitar cuotas; esos casos muestran un error y permiten sustitución manual. La ruta automatizada todavía debe probarse con un XML real del usuario.

## Pruebas

```sh
npm test
npm run typecheck
npm run build
```

La suite incluye parser, slots, identificadores repetidos, huecos, conflictos, DTD, orden de reversos, geometría A4, número de páginas, espejo de posiciones, sustitución de imágenes, bloqueo/confirmación de baja resolución y lectura del tamaño físico del PDF generado.

El parser se comprobó también con una exportación auténtica de MPC Fill de 100 posiciones: importó los 100 anversos, el reverso común y un reverso específico, sin avisos. El XML original no se incluye en el repositorio; el test usa datos redactados y conserva su estructura y cantidades.

## Perfil de impresión

El producto general de [barajas de Soriano](https://copisteriasoriano.com/imprimir/18637-baraja-de-cartas.html) pide A4 con montaje de nueve piezas, recomienda corte de 63 × 88 mm y al menos 2 mm de sangrado. El perfil usa 3 mm por defecto: cada marco ocupa 69 × 94 mm, centrado matemáticamente en la página A4 sin separación añadida entre cartas. Las marcas de corte se dibujan fuera del rectángulo de corte.

El ajuste **«El arte ya tiene sangrado»** expresa una decisión del usuario. Si está desactivado, MagicPnP extiende píxeles de borde para completar el sangrado; esa extensión no equivale a sangrado artístico real. Si está activado, el arte se interpreta como imagen que ya cubre el marco configurado. No se estiran las cartas: se usa relleno centrado con recorte. La vista previa ayuda a detectar el recorte antes de exportar.

Las posiciones del reverso se pueden reflejar horizontal o verticalmente. La ficha indica doble cara y páginas impares delanteras/pares traseras, pero no confirma la convención de volteo de este montaje. Imprime primero una hoja numerada y confirma la orientación con Soriano.

El PDF mantiene el color RGB; no se etiqueta como CMYK. La imprenta puede convertirlo y cambiar los tonos. Confirma también que tienes permiso para reproducir e imprimir los artes seleccionados.

## API y límites temporales

- `POST /api/projects/import` — importar XML y crear proyecto con token aleatorio.
- `GET /api/projects/:id` — consultar slots, avisos y estados.
- `POST /api/projects/:id/assets/download` — intentar descargas en grupos de hasta tres; se puede cancelar en `/assets/download/cancel`.
- `POST /api/projects/:id/assets/:assetKey/download` — reintentar una imagen.
- `POST /api/projects/:id/assets/:assetKey/replace` — subir sustitución JPG/PNG/WebP.
- `POST /api/projects/:id/back/replace` — subir reverso común personalizado.
- `PATCH /api/projects/:id/settings` — actualizar sangrado, marcas, modo de reverso y espejo.
- `POST /api/projects/:id/export` — validar y crear PDF temporal.
- `GET /api/projects/:id/export/:exportId` y `/report` — descargar PDF y reporte.
- `DELETE /api/projects/:id` — borrar el proyecto.

El XML está limitado a 2 MiB y 10.000 slots; cada imagen, a 25 MiB y 25 megapíxeles; cada proyecto, a 200 MiB; todos los proyectos temporales, a 500 MiB; y cada PDF, a 1.000 posiciones y 250 MiB, con una exportación temporal activa por proyecto y 500 MiB para todos los PDF. Hay un máximo de 10 proyectos activos y 1.000 imágenes por trabajo de descarga. El servidor limita importaciones por IP. Las imágenes se analizan y decodifican; las peticiones remotas solo pueden dirigirse a Google Drive y hosts permitidos de Google, con redirecciones limitadas. No se aceptan URLs arbitrarias del XML.

El proxy de despliegue debe reemplazar `X-Forwarded-For` con la IP real antes de activar `TRUST_PROXY=1` en la API. `compose.yaml` ya define esa cabecera en Nginx.

## Docker y Coolify

```sh
cp .env.example .env
docker compose up --build
```

La interfaz queda en `http://localhost:8080` (`WEB_PORT` permite cambiarlo). `GOOGLE_DRIVE_API_KEY` es opcional; guárdala en el entorno privado de Coolify y restringe la clave en Google Cloud. Los archivos y estados se guardan solo en la memoria del contenedor. Reiniciar el contenedor elimina los proyectos temporales.

## Pendiente antes de producción de imprenta

1. Verificar las descargas de Drive con referencias reales que sean accesibles y confirmar permisos/cuotas.
2. Acordar con Soriano el producto general, el orden dúplex y el tratamiento del sangrado.
3. Hacer una impresión física numerada para confirmar la alineación del reverso.
