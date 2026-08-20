# Guardian Cloud — Configuración OAuth de Google Drive

Estado a 2026-08-20. Documento de configuración vigente, no histórico.

> **Nunca añadir a este documento** `client_secret`, access tokens, refresh
> tokens, URLs firmadas ni `remote_reference`. Se registran identificadores
> públicos, clasificación de scopes y estado de publicación: nada más.

## Estado en Google Auth Platform

Comprobado manualmente en la consola de Google el 2026-08-20:

| Campo | Valor observado |
|---|---|
| Project number | `285217660535` |
| Cliente OAuth | `Guardian Cloud` |
| Publishing status | **`In production`** |
| User type | **`External`** |
| Scopes sensibles declarados | 0 |
| Scopes restringidos declarados | 0 |

### Scopes declarados

| Scope | Clasificación mostrada por Google |
|---|---|
| `https://www.googleapis.com/auth/drive.file` | no sensible |
| `https://www.googleapis.com/auth/userinfo.email` | no sensible |

`drive.file` es el scope por fichero: da acceso únicamente a los ficheros que la
propia aplicación crea, nunca al resto del contenido de Drive del usuario.
`userinfo.email` se solicita para registrar qué cuenta quedó conectada y
mostrarla en la pantalla de ajustes.

Ambas clasificaciones son **las mostradas por Google Auth Platform en la fecha
indicada**. Google puede reclasificar scopes o cambiar sus requisitos de
verificación; este documento registra lo observado, no una garantía sobre
decisiones futuras de Google. Antes de añadir cualquier scope nuevo, comprobar
su clasificación en la consola.

## Redirect URIs

| Entorno | Redirect URI |
|---|---|
| **Producción** | `https://api.guardiancloud.app/auth/drive/callback` |
| Desarrollo | túnel ngrok, definido en el `.env` local del backend |

El redirect de producción está confirmado como autorizado en el cliente OAuth.

El `.env` local del repositorio contiene un redirect de ngrok junto a
`NODE_ENV=development` y `PORT=3000`: es **configuración de desarrollo** y no
describe el backend productivo, que se sirve por Cloudflare Tunnel según
[`CLOUDFLARE_TUNNEL_SETUP.md`](./CLOUDFLARE_TUNNEL_SETUP.md). Un túnel ngrok
gratuito cambia de nombre de host al reiniciarse, así que un redirect de ngrok
obsoleto rompe el flujo de conexión aunque el de producción sea correcto.

El flujo de refresh **no** usa `redirect_uri`, de modo que una discrepancia aquí
afecta a conectar o reconectar Drive, nunca a renovar un token ya emitido.

## Cómo se obtiene el refresh token

La URL de autorización se construye en el backend con:

- `access_type=offline` — es lo que hace que Google devuelva un refresh token;
- `prompt=consent` — fuerza la reemisión del refresh token aunque el usuario ya
  hubiera concedido acceso antes.

Consecuencia práctica: **cada reconexión produce credencial nueva**. Existe
además una guardia que conserva el refresh token almacenado si un
re-consentimiento no devuelve uno, para que un segundo intento de conexión no
anule el único token que funcionaba.

El intercambio del código de autorización lo realiza la aplicación móvil: el
callback del backend no intercambia en servidor, sino que reenvía el código al
deep link del móvil. Por tanto **reconectar Drive requiere la aplicación**; no
puede completarse solo desde el backend.

## Aprendizaje registrado: `External + Testing` caduca refresh tokens

Durante la validación de hardware del 2026-08-20 toda subida a Drive falló con
`DRIVE_REFRESH_FAILED`. La causa fue la caducidad del refresh token por la
configuración OAuth, no el código:

- existía un refresh token almacenado;
- Google devolvió `HTTP 400` al endpoint de refresh, que el backend traduce a
  `401 DRIVE_REFRESH_FAILED`;
- la aplicación estaba en `Publishing status: Testing` con `User type: External`;
- en ese estado Google caduca los refresh tokens a los **7 días**;
- la última subida correcta fue el **13/08** y el fallo se produjo el **20/08**:
  exactamente 7 días;
- tras pasar a `In production` y reconectar, Drive volvió a funcionar y las
  subidas pendientes se completaron sin un solo fallo.

Ninguna línea de código había cambiado entre ambas fechas.

**Grado de certeza.** El cuerpo exacto de la respuesta de Google
—`DRIVE_TOKEN_REFRESH_FAILED_DETAIL`, con su campo `error`— **no se obtuvo**
durante la validación, así que `invalid_grant` no se leyó directamente. La
conclusión se apoya en el status `400`, la configuración vigente, la correlación
temporal exacta de 7 días y la recuperación posterior a la corrección.

**Implicación operativa.** Mientras una aplicación OAuth permanezca en
`Testing`, cualquier validación de hardware que dependa de Drive puede fallar
por caducidad de credencial sin que nada esté roto en el producto, y volverá a
fallar cada 7 días. Si en algún momento se devuelve la aplicación a `Testing`,
esta caducidad reaparece.

Diagnóstico y evidencia completos en
[`audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md`](./audits/GUARDIAN_CLOUD_NATIVE_SEGMENTED_DURABLE_CLEANUP_VALIDATION_2026-08-20.md).

## Cómo distinguir un fallo de credencial de uno de configuración

El status HTTP que recibe el cliente identifica el camino sin ambigüedad:

| Situación | Código y status |
|---|---|
| Falta alguna variable `GOOGLE_*` en el backend | `503 DRIVE_NOT_CONFIGURED` |
| No hay destination Drive, o no hay refresh token almacenado | `409 DRIVE_NOT_CONNECTED` |
| Google rechaza el refresh con `400` (p. ej. `invalid_grant`) | `401 DRIVE_REFRESH_FAILED` |
| Google responde 2xx sin token, o 5xx/429 con reintentos agotados | `502 DRIVE_REFRESH_FAILED` |

Un `401` indica credencial de usuario inválida —revocada, caducada o
sustituida—, y se resuelve reconectando Drive. Un `502` apunta a Google o a las
credenciales de cliente, y reconectar no lo arregla.

El backend registra `DRIVE_TOKEN_REFRESH_FAILED_DETAIL` con el cuerpo de la
respuesta de Google recortado y la longitud del refresh token —nunca su valor—,
que es la vía para confirmar el `error` exacto devuelto por Google.

> Deuda conocida: el cliente móvil clasifica cualquier `401` como transitorio
> antes de mirar el código, de modo que un `DRIVE_REFRESH_FAILED` se reintenta
> indefinidamente sin avisar al usuario de que debe reconectar. Registrada en
> [`KNOWN_DEBT.md`](./KNOWN_DEBT.md).
