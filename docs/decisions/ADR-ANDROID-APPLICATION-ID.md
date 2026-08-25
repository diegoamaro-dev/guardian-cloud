# ADR — `applicationId` de producción para Android

| | |
|---|---|
| **Estado** | Decisión arquitectónica **aceptada**. Implementada en código; despliegue en hardware **pausado** |
| **Fecha** | 2026-08-25 |
| **Decide** | Propietario del producto |
| **Afecta a** | Identidad técnica de la aplicación Android; futuros clientes OAuth Android; publicación en Google Play |
| **Implementado por** | `f82b111` — `feat(android): migrate production applicationId to com.guariacloud.app` |
| **Configuración observada en** | [`OAUTH_DRIVE_CONFIGURATION.md`](../OAUTH_DRIVE_CONFIGURATION.md) |

---

## Veredicto

```
applicationId de producción  →  com.guariacloud.app        MIGRA
namespace (Gradle)           →  com.guardiancloud.app      SE CONSERVA
paquetes y rutas Kotlin      →  com.guardiancloud.*        SE CONSERVAN
módulo nativo                →  com.guardiancloud.segrec   SE CONSERVA

La divergencia namespace ≠ applicationId es INTENCIONAL y NO es deuda.

Fuera de alcance: display name, scheme, dominios, ROOT_FOLDER_NAME,
clientes OAuth Android y rebranding general.
```

---

## 1. Contexto

### La migración de marca está decidida, pero no ejecutada

```
Guaria Cloud        marca y ecosistema futuros
Guaria Cloud App    nombre comercial previsto de ESTA aplicación
Guaria App          abreviatura admisible en uso INTERNO
                    ✗ NO como nombre comercial: existe uso previo por terceros
guariacloud.com     dominio bajo nuestro control
Guaria Hub          otro producto del mismo ecosistema
```

El rebranding general —display name, dominios, textos visibles— se hará
**posteriormente, de forma coordinada y auditable**. Guardian Cloud sigue siendo
el nombre vigente durante el cierre técnico actual.

### Por qué se decide ahora y no con el rebranding

Un `applicationId` no es una marca: es la identidad técnica de la aplicación en
el dispositivo y en la tienda. Su coste de cambio **sólo crece con el tiempo**, y
ahora mismo se cumplen a la vez tres condiciones que no volverán a darse:

```
· la aplicación NO está publicada en Google Play
· NO existe ningún cliente OAuth Android atado a package + SHA-1
· NO hay usuarios externos con instalaciones que preservar
```

Ésta es la ventana de menor coste de toda la vida del producto.

---

## 2. Decisión

**Migrar el `applicationId` de producción a `com.guariacloud.app`, conservando
`namespace`, paquetes Kotlin y rutas físicas como `com.guardiancloud.*`.**

`f82b111` implementa **únicamente** eso: dos líneas funcionales —`applicationId`
en `android/app/build.gradle` y `android.package` en `app.config.ts`— más cuatro
literales de coherencia en tests y un comentario. Nada más.

### Por qué `namespace` NO acompaña al cambio

`namespace` y `applicationId` están desacoplados en AGP por diseño, y en este
proyecto el desacoplamiento ya era estructural antes de la decisión:

```
el manifest NO declara package=          → `.MainActivity` y `.MainApplication`
                                           resuelven contra el NAMESPACE
NO existe FileProvider ni authorities    → el punto clásico de rotura no está
NO se usa ${applicationId}               → cero marcadores que reescribir
el módulo nativo tiene namespace propio  → registrado por nombre de clase
```

`namespace` sólo determina dónde viven `BuildConfig` y `R`. **No afecta a
identidad, firma, datos ni Play, y no es visible para el usuario.**

Verificado en el artefacto construido desde `f82b111`:

```
manifest del APK   package        = com.guariacloud.app          ← applicationId
                   activity name  = com.guardiancloud.app.MainActivity   ← namespace
dex                com/guardiancloud/app/MainActivity   presente
                   com/guardiancloud/segrec/*           intactos
                   com/guariacloud/*                    CERO clases
firma              sin cambios · applicationId y certificado son independientes
```

> **Esta divergencia no debe registrarse como deuda pendiente de rename.**
> Alinear `namespace` con `applicationId` obligaría a mover paquetes Kotlin y
> rutas físicas sin ningún beneficio observable, y a cambio introduce riesgo de
> compilación. Un futuro lector que la encuentre debe entenderla como lo que es:
> una decisión, no un descuido.

---

## 3. Alternativas evaluadas

### A · Conservar `com.guardiancloud.app`

**A favor.** Riesgo nulo sobre instalaciones, identidad, evidencia y recovery.
No toca firma, Kotlin, rutas ni scripts. Es práctica habitual y legítima: el
usuario **nunca ve el `applicationId`**, y multitud de productos conservan un
package que no coincide con su marca.

**En contra.** Incoherencia permanente entre marca e identificadores, con coste
cognitivo recurrente. Y desaprovecha la única ventana barata.

### B · Migrar el `applicationId` — **elegida**

**A favor.** Coherencia con el ecosistema `Guaria`; espacio de nombres común si
`Guaria Hub` u otros productos lo comparten; y se ejecuta en el momento de menor
coste posible.

**En contra.** Toda instalación existente deja de recibir actualizaciones y debe
reinstalarse, perdiendo su almacenamiento privado —identidad anónima incluida—.
Riesgo concentrado en un único punto, y asumido conscientemente antes de que
existan usuarios externos.

### C · Migrar además `namespace` y paquetes Kotlin — **descartada**

Multiplicaría la superficie —`namespace`, dos `.kt`, ruta física, script de
reconstrucción— sin ningún beneficio observable, y añade riesgo de compilación.
**No existe razón técnica** que obligue a alinearlos: ver §2.

> Aviso: `expo prebuild --clean` regeneraría el proyecto nativo alineando
> `namespace` y rutas con `android.package`, es decir, **haría C por su cuenta**
> y destruiría las personalizaciones nativas. No es motivo para hacer C; es
> motivo para que `prebuild` siga prohibido como paso rutinario, según
> [`RELEASE_CHECKLIST_v0.3.md`](../RELEASE_CHECKLIST_v0.3.md) §3.1.

---

## 4. Dónde está la irreversibilidad real

Conviene separar tres cosas que se confunden:

**Asociación.** Un cliente OAuth Android queda asociado al par
`package name + SHA-1`, y Google exige que ese par sea único en todos sus
proyectos. El vínculo no se reapunta: para otro package se crea **otro** cliente.

**Coste de recrear.** Si el `applicationId` cambiara, los clientes Android
existentes dejarían de servir y habría que crear los equivalentes. Es trabajo de
configuración y limpieza, **no una pérdida irreversible**: el Client ID de un
cliente Android es desechable —no es audiencia de nada y no aparece en ningún
`id_token`—.

**Irreversibilidad.** No la impone Google OAuth: la impone **Google Play**. Una
vez publicada la aplicación, el `applicationId` es su identidad permanente en la
tienda y no puede cambiarse — sería otra aplicación, con otra ficha y otros
usuarios.

```
★ El punto de no retorno es la PUBLICACIÓN EN PLAY.
  Todo lo anterior es coste, no barrera.
```

---

## 5. Consecuencias

```
firma              sin efecto · el certificado es independiente del applicationId
backend / Supabase sin efecto · el ownership se ancla al claim `sub`
base de datos      sin efecto · ningún nombre de tabla o columna deriva del package
evidencia ya subida sin efecto
instalaciones existentes  dejan de poder actualizarse: reinstalar destruye el
                          almacenamiento privado, incluida la identidad anónima
```

**La migración de hardware está PAUSADA.** `f82b111` cambia el código; su
despliegue en dispositivo se gobierna por gates propios, y el estado observado de
cada dispositivo vive **fuera de este repositorio**, en el paquete de evidencia
fechado que corresponda. Este ADR no describe dispositivos.

---

## 6. Lo que este ADR no hace

```
NO autoriza continuar B1 ni A1
NO autoriza crear clientes OAuth Android
NO autoriza el rebranding general ni el cambio de display name
NO toca scheme `guardiancloud`, dominios, ROOT_FOLDER_NAME ni ROOT_DIR
NO toca claves de almacenamiento (test.pending_retry, gc.identity.v1, guardian.*)
NO reescribe documentación histórica, auditorías ni evidencias congeladas
NO cambia el estado de ningún finding: GC-AUTH-SESSION-RECOVERY-001 sigue OPEN
```

El `applicationId` de iOS (`ios.bundleIdentifier`) **no se ha tocado**: no existe
build de iOS y su migración es una decisión aparte.
