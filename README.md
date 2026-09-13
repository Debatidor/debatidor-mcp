# @debatidor/mcp

Servidor remoto oficial de **Model Context Protocol (MCP)** para Debatidor.

`debatidor-mcp` es un adaptador fino entre clientes MCP (ChatGPT, Claude, IDEs y otros hosts compatibles) y `debatidor-back`. La autoridad de identidad, permisos, Arena, Lead, memoria y datos permanece en el backend; filesystem/shell se ejecutan exclusivamente en `debatidor-agent`.

## Arquitectura

```text
ChatGPT / Claude / IDEs
          |
    Streamable HTTP
          |
https://mcp.debatidor.com/mcp
          |
    debatidor-mcp
          |
     OAuth bearer
          |
    debatidor-back
      |         |
 Arena/PAL   /agent WS
                |
         debatidor-agent
                |
         proyecto / shell
```

El endpoint remoto es el camino de producto. `stdio` se conserva para clientes locales/IDE y debugging.

## Estado actual

Versión `0.8.0`:

- MCP TypeScript SDK v2, revisión objetivo `2026-07-28`;
- Streamable HTTP stateless en `/mcp`;
- Docker + `/health` y `/healthz`;
- Protected Resource Metadata en `/.well-known/oauth-protected-resource`;
- OAuth requerido en producción;
- ChatGPT y Claude validados como clientes reales contra el mismo endpoint;
- `debatidor_ping` y `debatidor_get_lead_status`;
- `debatidor_search_context` / `debatidor_index_context` sobre Context Service, la memoria propia de Debatidor;
- lectura completa, fuentes, exportación paginada, borrado derivado y política de memoria mediante las herramientas `context`;
- proyectos privados de contexto para agrupar fuentes y seleccionar exportaciones sin ampliar permisos;
- sesiones privadas con eventos raw, declaraciones explícitas con citas y estado operativo de materialización;
- `debatidor_quick_debate` para inyectar una intervención en una Arena existente;
- `debatidor_agent_list/read/write/shell` para operar un proyecto conectado por `debatidor-agent` sin DOM;
- bridge API-key legacy solo para dogfooding local/privado.

Para `quick_debate` en modo web, usar la extensión 0.4.7 o posterior, vincular la sala y habilitar la pestaña del proveedor. Indicar `connectionId` para dirigirse a un solo participante; si se omite, todos los participantes web configurados deben estar listos. La herramienta informa si el navegador no está configurado, no está listo o no pudo recibir el turno. `accepted: true` confirma el despacho; comprobar la respuesta del participante en la Arena y recargarla para verificar su persistencia. No reintentar automáticamente después de un fallo de despacho.

Las nuevas instrucciones de esta herramienta aparecen como **MCP** en la transcripción. El cliente externo no se identifica como ChatGPT o Claude a partir de su texto; su conversación y confirmación fuera de la llamada no se copian a la Arena. Los turnos web de `quick_debate` no habilitan herramientas de archivos o shell; las sesiones del agente y las herramientas MCP `debatidor_agent_*` mantienen sus propios permisos.

La memoria se consulta mediante Context Service y funciona sin claves ni créditos de proveedores externos. Esta versión admite recuperación textual e híbrida administrada, con disponibilidad explícita y fallback textual. Cada resultado incluye relevancia y procedencia; el ranking no se presenta como similitud coseno. Las herramientas de exportación y borrado requieren el backend P11 de gobernanza con las rutas `/context/items`, `/context/sources`, `/context/exports`, `/context/deletions` y `/context/governance`; no simulan éxito si el backend todavía no las ofrece.

## Desarrollo local

```bash
npm install
npm run check
npm test
npm run build
```

Servidor HTTP local sin OAuth:

```bash
DEBATIDOR_MCP_HOST=127.0.0.1 \
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002 \
DEBATIDOR_MCP_OAUTH_ENABLED=false \
npm run dev:http
```

Inspector oficial:

```bash
npx @modelcontextprotocol/inspector@latest
```

El CI levanta el build local y usa el Inspector para ejecutar `tools/list` y `debatidor_ping`.

## Producción

Endpoint MCP:

```text
https://mcp.debatidor.com/mcp
```

Probe público:

```text
https://mcp.debatidor.com/health
```

En producción `/mcp` está protegido por OAuth. No debe describirse `debatidor_ping` como una ruta HTTP pública; la reachability sin autenticación vive en `/health`.

Variables recomendadas:

```env
NODE_ENV=production
DEBATIDOR_MCP_HOST=0.0.0.0
DEBATIDOR_MCP_PORT=3002
DEBATIDOR_MCP_PUBLIC_BASE_URL=https://mcp.debatidor.com
DEBATIDOR_MCP_ALLOWED_HOSTS=mcp.debatidor.com
DEBATIDOR_MCP_OAUTH_ENABLED=true
DEBATIDOR_MCP_AUTHORIZATION_SERVER=https://api.debatidor.com
DEBATIDOR_API_BASE_URL=https://api.debatidor.com
DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=false
```

No configures `DEBATIDOR_API_KEY` en el endpoint público.

### OAuth / account linking

El MCP actúa como OAuth Resource Server y `debatidor-back` como Authorization Server.

```text
GET /.well-known/oauth-protected-resource
        -> authorization_servers: https://api.debatidor.com

cliente MCP
  -> Authorization Code + PKCE S256
  -> CIMD client identity
  -> consentimiento Debatidor
  -> access token user-scoped
  -> Authorization: Bearer <token> en /mcp
```

El bearer se valida contra el backend antes de crear las tools user-scoped. El MCP nunca representa a todos los usuarios con una API key global del contenedor.

## Tools

### `debatidor_ping`

Comprueba versión/protocolo/reachability dentro de una sesión MCP válida. No devuelve datos privados.

### `debatidor_get_lead_status`

Lee Arenas `LEAD` visibles en el workspace del principal OAuth. Con `debateId`, valida ownership antes de leer detalle.

### `debatidor_search_context`

Búsqueda read-only del contexto autorizado, opcionalmente limitada a una Arena con `debateId` o a 1–100 `sourceIds` únicos. Ambos filtros son excluyentes; elegir fuentes no concede acceso a sesiones privadas ajenas. Conserva `query` (requerido), `kinds` y `limit`; no requiere ejecutar previamente la tool de indexación.

`kinds` acepta `MESSAGE`, `CONCLUSION`, `FACT`, `DECISION` y `SUMMARY`. Para mantener las consultas de clientes anteriores, si se omite o se envía `[]`, el MCP manda explícitamente `['MESSAGE', 'CONCLUSION']` al backend. Los tipos nuevos se incluyen solo al solicitarlos: por ejemplo, `kinds: ['FACT', 'DECISION', 'SUMMARY']`; para los cinco tipos, envía los cinco valores. Los clientes que pidan tipos nuevos deben aceptar esos valores en los resultados.

El MCP consume `POST /context/search`, el mismo Context Service del Hub. Conserva `query`, `hitCount`, `hits` y los campos previos de cada hit. Añade:

- `score`: relevancia textual o híbrida, sin prometer una escala de similitud;
- `retrievalMethod: "text" | "hybrid"` y `semanticSimilarity: number | null`;
- `sourceId` y `provenance`: `messageId` (nullable), `sourceRevision` (entero), `originType` y `originId`;
- `retrieval` (método y disponibilidad semántica) y `partial` a nivel de respuesta; el contrato anterior `text` / `unavailable` sigue siendo válido.

El campo requerido heredado `similarity` se mantiene numérico: toma `semanticSimilarity` cuando existe una coincidencia semántica y `0` cuando es solo textual. Ese cero textual es un marcador de compatibilidad, **no una similitud coseno medida**. El texto de la tool distingue `score` de la similitud coseno y comunica método, disponibilidad semántica y resultados parciales.

El consumidor acepta también el contrato híbrido sin cambiar endpoints ni inputs: `retrieval.method` y `retrievalMethod` pueden ser `text` o `hybrid`; `semanticStatus` acepta `unavailable`, `warming`, `busy`, `ready` o `partial`. `score` es relevancia FTS o fusión RRF, nunca coseno; `semanticSimilarity` es `null` o un coseno entre -1 y 1. El envelope puede incluir `retrieval.modelKey` y `reason` (`disabled`, `model_unavailable`, `query_over_budget`, `index_pending`, `quota`, `timeout`, `inference_failed`).

Cada hit semántico incluye `provenance.chunk: { id, chunkerVersion, startUtf16, endUtf16 }`. Las posiciones son índices UTF-16 sobre el texto original, con fin excluido; `content` es la cita exacta y su longitud coincide con el rango. `hit.id` sigue identificando la entrada original. Los hits puramente textuales conservan `semanticSimilarity: null` y no tienen chunk, incluso dentro de una respuesta híbrida. Los consumidores deben desplegarse antes de activar el contrato híbrido del backend.

Una respuesta malformada del backend devuelve `isError: true`; nunca se transforma en una lista vacía ni provoca una indexación o un fallback automático al backend anterior. Una búsqueda válida sin coincidencias devuelve `hits: []` junto con sus metadatos. El endpoint backend heredado `/vector-memory/search` conserva su array para otros consumidores; este MCP utiliza el envelope canónico de Context Service.

### `debatidor_index_context`

Mantenimiento explícito para materializar o refrescar contexto desde mensajes persistidos de una Arena. Es una escritura no destructiva e idempotente por fuente; no es un requisito de la búsqueda normal y no consume una clave externa del usuario.

Usa `POST /context/index-debate`, alias del mantenimiento heredado `/vector-memory/index-debate`. Conserva `debateId` requerido, `limit` opcional (máximo 50) y el resultado `{ debateId, scanned, indexed, unchanged, empty, cappedAt }`. `indexed` cuenta materialización textual completada; `unchanged` cuenta fuentes cuya revisión permanece intacta. No indica embeddings creados ni trabajo meramente encolado.

### Memoria completa, exportación y borrado

Estas herramientas reutilizan la misma identidad autenticada y permisos de Context Service. `scope: { type: "user" }` selecciona memoria privada propia; `scope: { type: "workspace" }` selecciona fuentes compartidas, sin incluir memoria privada de otros usuarios. Los IDs de memoria/fuente son texto opaco: usa los devueltos por búsqueda o listado, sin convertirlos a UUID.

| Herramienta | Entrada | Resultado y operación |
|---|---|---|
| `debatidor_get_context_item` | `itemId` | `GET /context/items/:id`: contenido completo, procedencia y `canDelete` actual |
| `debatidor_list_context_sources` | `scope?: "user"\|"workspace"\|"project"`, `projectId?`, `cursor?`, `limit?` | `GET /context/sources`: `sources` y `nextCursor`; scope por defecto `user`, 50 fuentes por defecto, máximo 100; proyecto exige `projectId` |
| `debatidor_export_context` | `scope`, `format: "json"\|"markdown"`, `sourceIds?`, `kinds?` | `POST /context/exports`: crea un snapshot privado y devuelve solo metadatos |
| `debatidor_read_context_export` | `exportId`, `cursor?` | `GET /context/exports/:id`: una página completa del snapshot |
| `debatidor_delete_context_export` | `exportId` | `DELETE /context/exports/:id`: elimina los bytes del snapshot propio, sin borrar memoria canónica |
| `debatidor_delete_context_item` | `itemId` | `DELETE /context/items/:id`: borra memoria derivada autorizada; devuelve finalización o una operación pendiente |
| `debatidor_get_context_deletion` | `operationId` | `GET /context/deletions/:id`: consulta el estado de limpieza sin repetir el borrado |
| `debatidor_get_context_governance` | `{}` | `GET /context/governance`: retención, límites de exports, cuotas operativas y alcance del borrado |
| `debatidor_delete_context_sources` | `mode: "derived"`, `scope`, `sourceIds` | `POST /context/deletions`: borra memoria derivada existente de una selección explícita de 1–100 fuentes |

La lectura completa y las exportaciones conservan `id`, `sourceId`, `debateId`, `kind`, `content`, `createdAt` y `provenance: { messageId, sourceRevision, originType, originId, origins? }`, junto con `derivation` cuando existe. No aplican los límites de snippets de búsqueda, ni incluyen embeddings, razonamiento, credenciales, jobs internos o `provenance.chunk`. La lectura individual añade `canDelete`; el snapshot lo omite porque los permisos pueden cambiar. El contenido seleccionado puede contener datos personales escritos por el usuario: no se redacta automáticamente.

Crear un export requiere un scope y formato explícitos. `sourceIds` opcional selecciona 1–100 fuentes; al omitirlo, se incluyen las fuentes autorizadas del scope. `kinds` omitido incluye los cinco tipos, a diferencia del default compatible de `search_context`. La respuesta es `{ id, schemaVersion: 1, scope, format, itemCount, pageCount, expiresAt }`, sin host de descarga. Cada llamada crea un snapshot nuevo: no es idempotente.

El snapshot admite hasta 10.000 entradas o 32 MiB de payload, caduca en una hora y se limita a tres exports activos por principal. Un exceso devuelve error, nunca un export truncado. Para leerlo, omite `cursor` en la primera llamada y pasa el `nextCursor` recibido a la siguiente hasta obtener `null`. Cada página contiene hasta 100 entradas completas, los metadatos anteriores, `entries`, `nextCursor` y `markdown`. Un snapshot vacío tiene `itemCount: 0`, `pageCount: 1`, `entries: []` y `nextCursor: null`.

En formato `json`, `markdown` es `null`. En formato `markdown`, concatena literalmente los strings de cada página en orden: solo la primera incluye la cabecera. Las páginas representan el mismo contenido congelado; las ediciones ordinarias posteriores no lo actualizan. Cada lectura revalida todas las referencias del snapshot. Un borrado, pérdida de acceso o caducidad lo invalida con HTTP 410; no presentes páginas obtenidas antes como una exportación completa si falta el resto.

`delete_context_item` distingue HTTP 200 `{ deleted: true }` de HTTP 202 `{ deleted: false, operationId, status: "PENDING" }`. Pendiente significa que el item ya está oculto para búsqueda, pero la limpieza física aún no terminó. Consulta `get_context_deletion` con ese `operationId`; no repitas el DELETE para consultar estado. La operación devuelve `{ id, status, mode: "derived", scope, sourceIds, requestedAt, completedAt, itemCount }`: solo `COMPLETED` lleva fecha de finalización. Una operación creada desde otra superficie puede enumerar más de 100 fuentes; el límite 100 corresponde a la selección explícita de entrada.

El borrado derivado conserva mensajes y turnos originales. La finalización purga contenido derivado, vectores, copias legacy verificadas, trabajos de materialización y snapshots privados afectados; mantiene tombstones sin contenido para impedir resurrección. Las fuentes siguen admitiendo notas/turnos nuevos. Borrar fuentes compartidas exige OWNER; la tool exige `sourceIds` y nunca selecciona todo el workspace de manera implícita. Repetir ese POST genera otra operación y puede abarcar contenido posterior, por lo que no es idempotente. Las copias ya descargadas quedan fuera del control del servicio.

Las lecturas se marcan `readOnlyHint: true`. Crear snapshot se marca escritura no destructiva y no idempotente; borrar un item o export se marca destructivo e idempotente; borrar memoria de fuentes seleccionadas se marca destructivo y no idempotente. **Ninguna mutación se reintenta automáticamente.** Un error de transporte o respuesta inválida no permite inferir finalización.

El MCP valida IDs, formatos, contadores, paginación y estado de borrado; admite campos extra del backend para compatibilidad, pero devuelve solo el contrato declarado. HTTP 401 indica que debe renovarse la vinculación; un 403 de OWNER no implica que la sesión haya caducado. HTTP 404 mantiene indistinguibles recursos inexistentes y ajenos; 410 informa de snapshot inválido; 413 exige reducir explícitamente la selección; 429 indica límite de exports activos. Los cuerpos internos de errores no se exponen.

### Proyectos privados de contexto

Estas herramientas requieren el backend P11 con `/context/projects` y soporte de `scope: { type: "project", projectId }` en exportaciones y borrado derivado. No simulan éxito si esas rutas no están desplegadas. Un proyecto es una colección privada del usuario dentro de su workspace; no es una Arena ni una sesión de agente. Puede agrupar fuentes privadas propias y compartidas ya autorizadas, pero no concede permisos sobre ellas.

| Herramienta | Entrada | Operación |
|---|---|---|
| `debatidor_list_context_projects` | `cursor?`, `limit?` | `GET /context/projects`: página propia con `projects`, `nextCursor`; cada resumen incluye `id`, `name`, `createdAt`, `sourceCount` |
| `debatidor_create_context_project` | `name` | `POST /context/projects`: nombre de 1–120 caracteres, sin controles; crea colección vacía, máximo 50 por usuario |
| `debatidor_get_context_project` | `projectId` | `GET /context/projects/:id`: detalle con `sourceIds` actualmente legibles |
| `debatidor_update_context_project_sources` | `projectId`, `sourceIds` | `PUT /context/projects/:id/sources`: reemplazo explícito de 0–100 IDs únicos; `[]` vacía la colección |
| `debatidor_delete_context_project` | `projectId` | `DELETE /context/projects/:id`: elimina la colección e invalida sus snapshots administrados; conserva fuentes, memoria e historial |

Para seleccionar un proyecto en exportaciones y borrado derivado, pasa `scope: { type: "project", projectId: "<id devuelto>" }`. Para listar sus fuentes, usa `scope: "project", projectId: "<id devuelto>"`. `projectId` es obligatorio en ese ámbito y se rechaza con `user` o `workspace`, evitando que un filtro contradictorio se ignore. El catálogo del proyecto puede devolver fuentes `PRIVATE` y `WORKSPACE`; las reglas existentes de los otros ámbitos permanecen vigentes.

Un reemplazo de fuentes falla completo si alguna no está autorizada. Cambiar la selección afecta las exportaciones nuevas; un snapshot congelado conserva las fuentes admitidas mientras sigan autorizadas. Cada página revalida también la existencia y propiedad del proyecto. Eliminarlo invalida snapshots anteriores con HTTP 410 y no borra las copias ya descargadas o proyectadas a archivos locales. Borrar memoria derivada desde un proyecto mantiene los permisos de cada fuente: agrupar fuentes compartidas no permite a un miembro borrar lo reservado al OWNER.

Las lecturas son de solo lectura. Crear una colección es una mutación no idempotente. Reemplazar enlaces es destructivo sobre la selección e idempotente, aunque preserva contenido; eliminar la colección es destructivo y se marca no idempotente porque repetirlo devuelve 404. Ninguna mutación se reintenta automáticamente. Los parsers rechazan una respuesta de otro proyecto, selecciones incompletas, IDs duplicados, paginación contradictoria o éxito HTTP inesperado; no devuelven campos internos adicionales del backend.

### Sesiones raw, declaraciones y procedencia

Estas nueve herramientas requieren las rutas P11 `/context/sessions`, `/context/declarations`, `/context/origins` y `/context/status`. Las sesiones son historial privado del usuario autenticado; no crean Arenas ni conexiones de agente. Captura solo contenido autorizado, con el rol indicado explícitamente por el llamador.

| Herramienta | Entrada | Operación |
|---|---|---|
| `debatidor_create_context_session` | `label`, `projectId?`, `clientSessionId?` | Crea una sesión privada y opcionalmente la vincula a un proyecto propio |
| `debatidor_list_context_sessions` | `projectId?`, `cursor?`, `limit?` | Lista sesiones propias, 50 por defecto y máximo 100 |
| `debatidor_get_context_session` | `sessionId`, `cursor?`, `limit?` | Dos lecturas autorizadas: página de eventos y metadatos; devuelve `{session, transcript}` únicamente si ambas terminan bien |
| `debatidor_append_context_session` | `sessionId`, `clientEventId`, `role`, `content` | Guarda un evento exacto; `role` es HUMAN, ASSISTANT, TOOL o SYSTEM; máximo 32768 bytes UTF-8 |
| `debatidor_close_context_session` | `sessionId` | Impide nuevos eventos; conserva historial y memoria |
| `debatidor_create_context_declaration` | `clientDeclarationId`, `sourceId`, `kind`, `content`, `origins` | Registra FACT, DECISION o CONCLUSION declarados, máximo 24000 bytes UTF-8, con 1–32 citas de una misma fuente |
| `debatidor_get_context_declaration` | `declarationId` | Lee la declaración raw y su estado current, stale o forgotten |
| `debatidor_get_context_raw_origin` | `rawType`, `rawId`, `revision` | Lee una revisión autorizada MESSAGE o SESSION_EVENT y verifica SHA-256 de su contenido |
| `debatidor_get_context_status` | `{}` | Estado semántico y contadores operativos de raw, resúmenes y cola de conocimiento |

`queued` confirma la admisión durable del raw, sin afirmar que terminó la materialización. Los resúmenes se generan automáticamente mediante extracción propia; no requieren BYOK. FACT, DECISION y CONCLUSION son afirmaciones declaradas con procedencia, no clasificaciones automáticas ni verificación factual independiente.

`clientEventId` y `clientDeclarationId` son obligatorios. Repetirlos explícitamente con el mismo contenido conserva el registro; cambiar la petición devuelve conflicto. `clientSessionId` permite repetir explícitamente la creación con el mismo label/proyecto; omitirlo crea una sesión nueva en cada llamada. Ninguna mutación se reintenta automáticamente y una respuesta inválida no permite inferir finalización. Los límites de contenido se validan en bytes UTF-8 sin recortarlo.

Para recorrer un transcript, pasa `transcript.nextCursor` sin modificarlo hasta recibir `null`. La página fija `throughSequence`; los eventos nuevos se leen iniciando otra primera página. Si se revoca el acceso entre las dos lecturas, la herramienta falla completa sin devolver metadatos ni transcript parciales. Cerrar o borrar memoria derivada conserva el historial raw autorizado.

Las búsquedas, lecturas y exportaciones preservan `provenance.origins?: [{rawType, rawId, sourceId, revision, startUtf16, endUtf16}]` y `derivation?: {method, pipelineVersion: 1, coverage?}`. Los offsets cuentan unidades UTF-16, con fin excluido. Una declaración exige citas no vacías sobre revisiones actuales; consulta primero `get_context_raw_origin` y respeta los límites Unicode. Un resumen puede registrar un rango vacío `0..0` para un input considerado sin cita. `coverage` contiene solo contadores y booleanos; describe cobertura, no confianza factual. `method` es `verbatim`, `extractive` o `declared`. El contrato anterior sin estos campos sigue siendo válido; `null`, spans invertidos, procedencia de otra fuente y metadata malformada se rechazan.

`knowledge` en status conserva conteos y bytes raw, mensajes pendientes de preparar para conocimiento (`raw.pendingMessageHydration`), resúmenes vigentes/obsoletos/olvidados y cola pendiente/en ejecución/fallida, con antigüedad y p95 de finalización. El historial de trabajos completados se conserva siete días; esos contadores no representan toda la vida del producto. Un backend anterior sin `knowledge` no se interpreta como cero.

La suite cubre contratos y transporte HTTP MCP con una Context API HTTP simulada, incluidos permisos denegados, reintentos explícitos, respuestas malformadas y revocación entre lecturas. No representa una nueva validación de ChatGPT o Claude ni una prueba Nest/PostgreSQL; esas pruebas pertenecen al backend.

### `debatidor_quick_debate`

Inyecta una intervención en una Arena **ya existente** y reutiliza el runtime real de Arena. No crea un segundo orquestador dentro del MCP.

Inputs:

- `debateId`: Arena del workspace autenticado;
- `prompt`: intervención a persistir/despachar;
- `mode`: `web`, `api` o `both`;
- `connectionId`: opcional para dirigir la parte DOM.

Es no idempotente: repetirla genera otra intervención. `mode=api` puede consumir proveedores BYOK; `mode=web` puede usar un participante web conectado por la extensión sin consumir una API BYOK.

El backend tiene cobertura de integración del camino:

```text
quickDebate
  -> agent.say
  -> persistHumanMessage
  -> Arena/PAL runtime
  -> persistCompletedTurn
```

Para comprobar el recorrido completo, ejecuta un `quick_debate` desde tu cliente MCP y confirma la respuesta persistida al recargar la Arena.

## Proyecto conectado por `debatidor-agent`

```text
ChatGPT / Claude
      |
   tool MCP
      |
debatidor-mcp
      |
debatidor-back
      |
  /agent WS
      |
debatidor-agent
      |
filesystem / shell
      |
 resultado MCP
      |
mismo turno
```

Arranca el agent desde la raíz del proyecto:

```bash
cd mi-proyecto
debatidor connect --remote
```

Las rutas quedan confinadas al `cwd` en backend y agent.

### `debatidor_agent_list`

Lista un directorio relativo. Read-only e idempotente.

### `debatidor_agent_read`

Lee un archivo relativo. Read-only e idempotente.

### `debatidor_agent_write`

Crea/reemplaza un archivo relativo. Modifica disco y se marca destructiva.

### `debatidor_agent_shell`

Ejecuta un comando no interactivo. Shell headless está **apagado por defecto**.

Para habilitarlo conscientemente:

```bash
debatidor connect --remote --shell-auto
```

Sin `--shell-auto`, devuelve `denied_headless_shell_disabled`.

Las tools aceptan `agentId` opcional. La evolución P9/ADR-0012 exige que targets explícitos fallen cerrado si el agent no está conectado y que reconexiones reemplacen registros stale.

### Media Rail: media binaria bidireccional

Jerarquía que codifican las descripciones de las tools (el modelo debe respetarla):

1. **`debatidor_agent_put`** con URL HTTPS pública: el agente descarga directo. Cero bytes por el contexto del LLM.
2. **`debatidor_asset_ticket`**: URL temporal de un solo uso (token de 192 bits, TTL 15 min por defecto) servida por `debatidor-back` en `/asset-relay`. Acepta `PUT` con el cuerpo crudo (`curl -T`, `fetch(url, {method:"PUT", body: blob})`, la extensión de Chrome, n8n) o `POST` multipart con el campo `file`. El back calcula el SHA-256 al vuelo y empalma con `asset.begin/chunk/commit` del agente con varios chunks en vuelo; si no hay `Content-Length` hace spool a disco acotado. Con `direction: "download"` ocurre lo inverso: el archivo del proyecto se transmite en streaming (`agent.file_chunk`) a quien tenga la URL.
3. **`debatidor_asset_begin/chunk/commit/abort`**: último recurso para entornos **sin egress de red** (p. ej. un intérprete de código aislado a nivel DNS, donde `debatidor_asset_ticket` no es alcanzable). Mueve el archivo como una secuencia de tool-calls, así que es lento; se reserva para cuando 1) y 2) no son posibles. El tamaño de chunk es configurable en `begin` (`chunkSize`, 4096–65536 bytes, default 16384): elige el más pequeño que tolere el canal de I/O del host para que cada fragmento entre holgado en un turno. Cada chunk viaja en `base64` (default) o `hex`; ambas son codificaciones estándar de bytes y `hex` existe para canales que maltratan ciertos caracteres de base64. Ver la sección "Subida por chunks en entornos air-gapped" para un script listo para usar.

Lectura: **`debatidor_agent_get`** devuelve la imagen como bloque `image` (png/jpeg/gif/webp, el modelo la ve) o un `resource` embebido para pdf/audio/video/zip, con `sha256`, `mimeType` detectado por magic bytes y `width/height`. `metadataOnly=true` inspecciona sin transferir bytes; el inline está acotado (8 MiB por defecto, 32 MiB máximo) y por encima se usa un ticket de descarga. **`debatidor_asset_ticket_status`** confirma que una transferencia terminó y expone el `sha256` final.

Requisitos: `debatidor-back` con `/asset-relay` y la tool `fs.get`; `debatidor-agent` >= 0.6.0 (capabilities `fs.get` y `asset.stream`).

### Subida por chunks en entornos air-gapped

Algunos hosts ejecutan el código del cliente en un sandbox **sin salida de red**: `requests.put()` hacia el Asset Relay falla con `Could not resolve host`. En ese caso el único canal de salida son las tool-calls del MCP, que tienen un límite de tamaño de mensaje por turno. El flujo es `debatidor_asset_begin` → N × `debatidor_asset_chunk` en orden → `debatidor_asset_commit`, leyendo el archivo con un buffer del tamaño que devuelve `begin`.

Script de referencia (lectura por buffers, sin transformar los bytes). El host lo ejecuta en su propio entorno; cada `emit(...)` representa una llamada a la tool correspondiente:

```python
import base64, hashlib

def upload_local_file(path, dest, emit_begin, emit_chunk, emit_commit, chunk_size=16384):
    """Sube un archivo local por el canal de tool-calls cuando no hay red.
    emit_begin/emit_chunk/emit_commit invocan debatidor_asset_begin/chunk/commit
    y devuelven su structuredContent."""
    size = 0
    sha = hashlib.sha256()
    with open(path, "rb") as fh:
        data = fh.read()
    size = len(data)
    sha.update(data)

    begin = emit_begin({
        "path": dest,
        "bytes": size,
        "sha256": sha.hexdigest(),
        "chunkSize": chunk_size,
    })
    # El agente puede recortar chunkSize a su rango: usa el que devuelve.
    step = begin["chunkSize"]
    upload_id = begin["uploadId"]

    index = 0
    for offset in range(0, size, step):
        block = data[offset:offset + step]
        emit_chunk({
            "uploadId": upload_id,
            "index": index,
            "encoding": "base64",
            "base64": base64.b64encode(block).decode("ascii"),
        })
        index += 1

    return emit_commit({"uploadId": upload_id})
```

Para leer archivos muy grandes sin cargarlos enteros en memoria, sustituye la lectura completa por `fh.read(step)` en un bucle, actualizando `sha` e `index` en cada iteración. Si el canal rechaza caracteres de base64, cambia `encoding` a `"hex"` y envía `"hex": block.hex()`. El `commit` devuelve el `sha256` que calculó el agente: compáralo con el local para confirmar integridad de extremo a extremo.

## Clientes validados

### ChatGPT

Primer cliente de aceptación. Validado con OAuth, lectura de Arena y control de repo por `MCP → backend → agent` incluyendo filesystem, shell, Git y una tarea de coding real.

### Claude

Segundo cliente real de portabilidad. Validado contra **el mismo endpoint MCP**, con OAuth/CIMD y operaciones `list/read/shell` sobre el repo conectado.

No existe un adapter MCP específico para Anthropic.

### Gemini y otros hosts

Deben consumir el mismo endpoint cuando el host ofrezca remote MCP compatible. Gemini/DCR es compatibilidad posterior y no bloquea P7 porque la portabilidad ya fue demostrada con Claude.

## Operación y smoke tests

### CI local del protocolo

Cada PR/push ejecuta typecheck/tests/build, levanta el servidor y usa el **MCP Inspector oficial** para:

```text
tools/list
  -> descubre debatidor_ping

tools/call debatidor_ping
  -> respuesta válida
```

### Remote production smoke

`.github/workflows/remote-smoke.yml` se ejecuta en cambios relevantes, manualmente y de forma programada. Verifica sin credenciales de usuario:

- `/health` devuelve servicio/version/OAuth esperados;
- Protected Resource Metadata apunta al Authorization Server correcto;
- `/mcp` sin bearer devuelve `401` + `WWW-Authenticate` con `resource_metadata` correcto.

No almacena tokens humanos ni automatiza consentimiento OAuth.

## Dirección del protocolo

La dirección nativa es:

```text
cliente MCP -> Debatidor -> agent/Arena -> resultado al mismo cliente
```

Un servidor MCP no se usa para despertar espontáneamente una conversación web a partir de un mensaje iniciado por el CLI. Para `CLI -> chat web` sigue existiendo la extensión DOM o un runtime de modelo controlado por API.

## stdio / bridge legacy

Para dogfooding privado puede deshabilitarse OAuth y usar una API key:

```env
DEBATIDOR_MCP_PUBLIC_BASE_URL=http://127.0.0.1:3002
DEBATIDOR_MCP_OAUTH_ENABLED=false
DEBATIDOR_MCP_ENABLE_LEGACY_API_KEY_BRIDGE=true
DEBATIDOR_API_KEY=deb_live_xxx
```

Nunca uses este modo en `mcp.debatidor.com`.

## Seguridad

- No hay una API key global de usuario embebida en producción.
- El MCP valida bearer antes de exponer datos/tools user-scoped.
- Backend conserva autoridad de audience/resource/scope/tenant/ownership.
- Quick debate, memoria y agent execution permanecen workspace-scoped.
- `agent.file_result` solo resuelve tareas del mismo `userId + workspaceId`.
- Filesystem se valida en backend y agent, incluyendo rutas Unix/Windows.
- Shell remota requiere `--shell-auto`.
- Las llaves BYOK nunca cruzan hacia el MCP.
- Authorization codes y refresh tokens se almacenan hasheados; refresh rota.
- No loguear tokens, códigos OAuth, API keys ni payloads sensibles completos.
- Las annotations MCP deben reflejar side effects reales.

## P7 — gates restantes

La infraestructura/protocolo están verificados. Antes de declarar P7 cerrado faltan únicamente dos pruebas de producto con identidades reales:

1. ChatGPT autenticado ejecuta `debatidor_quick_debate` y se confirma un `turn.completed` persistido.
2. Dos users/workspaces distintos demuestran aislamiento efectivo entre debates/agents.

La memoria first-party se implementa en P11 y no es un gate de cierre de P7.
