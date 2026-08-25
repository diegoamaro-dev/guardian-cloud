# Guardian Cloud — Configuración OAuth de Google Drive

Estado a 2026-08-20. Documento de configuración vigente, no histórico.

> **Nunca añadir a este documento** `client_secret`, access tokens, refresh
> tokens, URLs firmadas ni `remote_reference`. Se registran identificadores
> públicos, clasificación de scopes y estado de publicación: nada más.

> **El proyecto aloja desde el 2026-08-25 DOS clientes OAuth.** El cuerpo de
> este documento describe el de **Drive**. El segundo —la audiencia de
> identidad de A1— se registra en la última sección y **no está en uso**.

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

---

# Segundo cliente OAuth — audiencia de identidad (A1)

Creado el **2026-08-25** en el mismo proyecto. **No está en uso**: ninguna app
lo referencia y Supabase no lo tiene autorizado.

| Campo | Valor observado |
|---|---|
| Nombre | `Guardian Cloud — identity audience (prod)` |
| Tipo | Web application |
| Client ID | `285217660535-gqae2dvua9mu52vbrc3hccgmgcb255o5.apps.googleusercontent.com` |
| Authorized JavaScript origins | vacío |
| Authorized redirect URIs | vacío |
| Estado | Enabled |

El `client_secret` **no se usó, no se copió y no se registra**: el flujo nativo
no lo necesita. El Client ID sí es público —viaja dentro de la app como
`serverClientId`— y por eso puede constar aquí.

## Para qué existe, y por qué es un cliente distinto

Es la **audiencia** (`aud`) de los `id_token` que emitirá Google en el flujo
nativo de A1, y es lo que Supabase validará. Documentación de Supabase, verbatim:
«You have to create OAuth client IDs for both a Web and Android application.
**The Web client ID is the one used in your Android app.**»

**No reutiliza el cliente de Drive, y no debe hacerlo nunca.** Aquél es un
cliente confidencial de servidor, con `client_secret` y `redirect_uri`, para un
consentimiento de almacenamiento (`drive.file`). Éste es la identidad. Mezclarlos
sería usar un token concedido para una cosa como acreditación de otra.

## Independencia verificada

```
project number del Client ID nuevo   285217660535
project number registrado arriba     285217660535   → mismo proyecto
sufijo del cliente                    gqae2dvua9mu52vbrc3hccgmgcb255o5
                                      distinto del de Drive · cliente independiente
```

## ⚠️ BARRERA — no crear clientes OAuth **Android** todavía

Conviene separar tres cosas que se confunden con facilidad:

**1 · Asociación.** Un cliente OAuth Android queda asociado al par
`package name + SHA-1`, y Google exige que ese par sea único en todos sus
proyectos. Ese vínculo no se reapunta: para otro package se crea **otro**
cliente.

**2 · Coste de recrearlo.** Si el `applicationId` cambia, los clientes Android
existentes dejan de servir y hay que crear los equivalentes para el package
nuevo. Es trabajo de configuración y limpieza —credenciales huérfanas, entradas
que retirar, documentación que rehacer—, **no una pérdida irreversible**. El
Client ID de un cliente Android es desechable: no es audiencia de nada y no
aparece en ningún `id_token`.

**3 · Dónde está de verdad la irreversibilidad.** No la impone Google OAuth, la
impone **Google Play**: una vez publicada la aplicación, el `applicationId` es su
identidad permanente en la tienda y no puede cambiarse — sería otra aplicación,
con otra ficha y otros usuarios. Antes de ese punto el package sigue siendo
modificable, al coste conocido de romper la actualización de las instalaciones
existentes.

**Conclusión operativa, que no cambia**: crear clientes Android antes de decidir
el naming **no vuelve irreversible el package**, pero añade deuda y superficie de
migración sin ninguna ganancia. No se crea ninguno hasta completar
`G-NAMING-SCOPE`.

Y hay una decisión de marca tomada pero **no ejecutada**:

```
hoy              Guardian Cloud / Guardian Cloud App     ← implementación vigente
dirección futura marca y ecosistema: Guaria Cloud
                 esta app, comercialmente: Guaria Cloud App
                 internamente: Guaria App
                 «Guaria App» NO se usa como nombre comercial principal:
                 hay uso previo por terceros
dominio          guariacloud.com bajo nuestro control
ecosistema       existen proyectos relacionados, entre ellos Guaria Hub
cuándo           NO ahora · migración posterior, coordinada y auditable
```

**Esto no implica que `com.guardiancloud.app` deba cambiar.** Un `applicationId`
es un identificador técnico, no una marca, y cambiarlo tiene coste real:
rompe la actualización de instalaciones existentes y, tras publicar en Play, es
**irreversible**. Un rename cosmético que rompa identidad, recuperación, firma o
compatibilidad sería un mal negocio.

Antes del primer cliente Android hace falta un análisis que separe qué migra de
verdad y qué conviene conservar aunque contenga `guardiancloud`:

```
nombre comercial / display name        ·  applicationId / package Android
clientes OAuth Android                 ·  este Web Client de identidad
cliente OAuth de Drive                 ·  Supabase
EAS                                    ·  Google Play / Play App Signing
dominios y callbacks                   ·  cualquier identificador persistente
```

El Web Client de arriba **no participa de esa barrera**: no contiene el nombre,
no depende del package y no se muestra al usuario. Por eso pudo crearse antes de
resolver la marca.

## Cuestión abierta: `Q-WEBCLIENT-MUTABILITY`

Está **sin verificar** si el Client ID pasa a ser irreemplazable en cuanto exista
el primer usuario vinculado. Falta determinar a qué se ancla `auth.identities`
—`provider_id`, `aud` o ambos—, si Supabase admite **añadir** un segundo Client
ID sin invalidar lo ya vinculado, y si el `sub` de Google varía al cambiar la
audiencia. Hasta resolverlo, **no se trata como hecho arquitectónico**.

Lo que sí está verificado: el Web Client ID es el `aud` del `id_token` y es lo
que Supabase valida.
