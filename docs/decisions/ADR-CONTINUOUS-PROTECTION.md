# ADR — Continuous Protection: la Protection Session como unidad lógica

| | |
|---|---|
| **Estado** | Contrato de producto **aceptado**. **NO implementado** |
| **Fecha** | 2026-08-25 |
| **Decide** | Propietario del producto |
| **Refina a** | [`ADR-VIDEO-NATIVE-SEGMENTATION`](./ADR-VIDEO-NATIVE-SEGMENTATION.md) |
| **Afecta a** | `PRODUCT_PRINCIPLES`, `MVP_SCOPE`, `ARCHITECTURE`, `APP_STATES`, `UI_SCREENS`, `TEST_SCENARIOS`; D3; export final; contrato de sesión del backend |
| **Implementado por** | **Infraestructura parcial, no la capacidad**: `8983bad` (metadata durable `evidence_closed`) y `6c6489c` (desacople del camino de **lectura** de terminalidad). La capacidad —`VIDEO_AUDIO → AUDIO_ONLY`— sigue **sin implementar** |

> **Este documento decide; no describe el sistema actual.** Ninguna de sus
> secciones acredita capacidad implementada ni validada. El estado real por
> capacidad vive en
> [`IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md), que prevalece.
> Continuous Protection figura allí en **Nivel 3 — planificado**.

---

## Veredicto

```
La unidad lógica y de custodia es la PROTECTION SESSION.
Los productores de vídeo y audio son FASES dentro de ella.

        producer closed  ≠  Protection Session closed

PARAR es la única acción normal y explícita del usuario que
termina una Protection Session.

foreground/visible          →  VIDEO_AUDIO   (si la fase inicial es vídeo)
background / pantalla bloqueada →  AUDIO_ONLY

Cámara en background: NO AUTORIZADA.

Fuera de alcance: la representación técnica de estas distinciones,
el retorno automático a vídeo, y el export final multi-fase.
```

---

## 1. Definición formal de Protection Session

Una **Protection Session** es el intervalo continuo de protección que el
usuario abre con una acción explícita y cierra con otra acción explícita.

```
inicio    acción explícita GRABAR
fin       acción explícita PARAR
```

Dentro de ese intervalo, la captura puede cambiar de medio una o más veces sin
que la sesión termine ni se divida.

### Identidad única

Una Protection Session conserva **una identidad lógica única durante toda su
vida**. Las transiciones de fase:

- no crean una sesión nueva,
- no crean ni alteran la propiedad (*ownership*) de la evidencia,
- no reinician contadores de orden ni de integridad.

Toda la evidencia producida en cualquiera de sus fases pertenece a la misma
sesión y al mismo titular. Una transición multimedia **nunca** es un punto de
cambio de custodia.

### Qué NO es una Protection Session

No es «una grabación de vídeo». No es «una grabación de audio». El medio es un
atributo de la fase, no de la sesión.

---

## 2. `producer closed ≠ Protection Session closed`

Es el principio central de este ADR.

**Cerrar un productor multimedia significa**: ese productor deja de capturar, y
la evidencia que produjo queda íntegramente adoptada y persistida.

**No significa**: que la Protection Session haya terminado.

```
PARAR es la única acción normal y explícita del usuario que termina
una Protection Session.

Las terminaciones anómalas —cierre forzado, muerte del proceso,
reinicio del dispositivo, cualquier interrupción no solicitada— y su
resolución mediante recovery se definen por sus contratos específicos
y NO deben interpretarse automáticamente como un STOP del usuario.
```

Esta segunda frase es deliberada y restrictiva. Una sesión interrumpida y
recuperada **no** equivale a una sesión que el usuario cerró: son dos caminos
distintos, con contratos distintos, y confundirlos produciría exactamente el
error que este ADR corrige, sólo que desplazado al recovery.

### La representación se decide en G1

Este ADR fija **la semántica**, no su forma. No decide nombres de campo,
estados adicionales, banderas ni esquema de almacenamiento. Cualquier lector
que busque aquí el mecanismo concreto está en el documento equivocado: eso
pertenece al gate G1.

---

## 3. Política de captura por visibilidad

```
VISIBLE / foreground        VIDEO_AUDIO
   ↓ HOME · bloqueo de pantalla · pérdida real de visibilidad
BACKGROUND / LOCKED         AUDIO_ONLY
```

Cuando la fase inicial elegida es vídeo, la aplicación captura vídeo y audio
mientras es visible. Al perder la visibilidad, el productor de vídeo **deja de
capturar de forma controlada** —terminando y adoptando la evidencia en curso— y
la protección **continúa automáticamente mediante audio**.

Una Protection Session iniciada en audio permanece en `AUDIO_ONLY`; para ella la
transición no aplica.

### Prohibición de cámara en background

**No se autoriza la captura de vídeo con la aplicación en segundo plano ni con
la pantalla bloqueada.** Es una restricción deliberada de producto, no una
limitación técnica heredada.

Una herramienta de evidencia que pudiera grabar vídeo sin presencia visible en
pantalla sería indistinguible, en comportamiento observable, de una herramienta
de vigilancia encubierta. Guardian Cloud no la ofrece.

> Esta prohibición **supera** la formulación histórica de
> [`STATE_v0.2_BACKGROUND_RECOVERY.md`](../STATE_v0.2_BACKGROUND_RECOVERY.md),
> que registraba el vídeo en background como «limitación Android + Expo». Aquel
> documento está superado y no se edita; queda como registro histórico. Lo
> vigente es lo que decide este ADR: es una decisión, no una carencia, y no debe
> tratarse como deuda pendiente de resolver cuando la plataforma lo permita.

---

## 4. El transporte es independiente de la fase de captura

La subida de evidencia **no depende de qué productor esté activo ni de si hay
alguno activo**. Continúa durante las transiciones de fase, con la aplicación en
segundo plano y después de que toda captura haya cesado, hasta agotar la cola.

Es la aplicación directa del principio vigente
—[`PRODUCT_PRINCIPLES`](../PRODUCT_PRINCIPLES.md) §1, *subir evidencia por
encima de grabar perfecto*— y del invariante *evidencia fuera del dispositivo
ASAP*.

Ninguna transición de fase puede pausar, reiniciar ni vaciar la cola.

---

## 5. Cero decisiones del usuario durante la transición

**El usuario no toma ninguna decisión durante un cambio de fase.** No hay
diálogos, no hay confirmaciones, no hay opciones y no hay nada que perder por no
mirar la pantalla.

La transición debe ser **legible sin ser una interrupción**: el usuario ha de
poder saber en qué fase está si mira, y no ha de necesitar mirar para seguir
protegido.

Deriva de [`PRODUCT_PRINCIPLES`](../PRODUCT_PRINCIPLES.md) §2 —*si el usuario
tiene que pensar, el diseño es incorrecto*— y su superficie visible se define en
[`UI_SCREENS`](../UI_SCREENS.md), sujeta a la regla de *cero distracciones*
durante la grabación activa.

---

## 6. Terminalidad, interrupción y recovery

### `/complete`

`/complete` es la operación que declara **terminada una Protection Session**. No
es la consecuencia de que un productor haya dejado de capturar.

Mientras una Protection Session siga abierta, no puede emitirse `/complete`,
aunque en ese instante no haya ningún productor activo y toda la evidencia
producida hasta entonces esté subida.

### Cleanup

El cleanup de la evidencia local pertenece a la **terminalidad de la sesión**,
nunca al cierre de una fase. **Ninguna fase puede eliminar su evidencia local al
terminar.** La autorización para borrar sigue anclada donde ya lo está: en la
confirmación durable de que la evidencia existe fuera del dispositivo.

### Interrupción y recovery

Una Protection Session interrumpida por una terminación anómala es una **sesión
no terminada**, no una sesión cerrada. Su resolución se rige por el contrato de
recovery y **no equivale a un PARAR del usuario** (§2).

Consecuencia que este ADR fija y que el diseño de recovery deberá respetar: el
recovery de una sesión multi-fase debe preservar la integridad y la
distinguibilidad de **todas** sus fases. Resolver una sesión mixta describiéndola
por una sola de sus fases sería una pérdida de información sobre la evidencia,
no un detalle de implementación.

---

## 7. La evidencia se describe por unidad, no por sesión

```
El tipo y la fase de la evidencia deben poder describirse POR UNIDAD DE
EVIDENCIA, y nunca inferirse de un modo global de sesión.
```

Una Protection Session puede contener evidencia de más de un tipo. Un modelo que
asigne un único tipo a toda la sesión no puede describirla sin mentir.

### Prohibición explícita

**El backend y el manifiesto no pueden describir evidencia mixta como si fuera
exclusivamente vídeo**, ni exclusivamente audio. Un manifiesto que declare un
tipo que su contenido no tiene es evidencia mal descrita, y una evidencia mal
descrita es un defecto de integridad —no un defecto cosmético.

Esta prohibición es **bloqueante**: hasta que el contrato de sesión admita
describir fases, no puede producirse evidencia mixta.

El cambio correspondiente en el contrato del backend queda fuera de este ADR y
requiere gate propio.

---

## 8. Consecuencias para D3 y para el export

### D3 — `LOCAL SEGMENT SALVAGE`

D3 es hoy la única salida offline validada en hardware para el vídeo nativo
segmentado. Una Protection Session multi-fase **cambia sus supuestos**: la
distinción entre lo que D3 debe extraer y lo que debe rechazar deja de ser una
propiedad de la sesión y pasa a ser una propiedad de cada unidad de evidencia.

```
D3 deberá evolucionar a multi-fase SIN perder integridad:
  · nunca escribir evidencia de un tipo con el nombre o el formato de otro
  · nunca declarar en su manifiesto un tipo que el contenido no tiene
  · conservar la verificación por re-lectura que ya realiza
```

**Requiere gate independiente.** D3 no se toca en el mismo gate que Continuous
Protection.

### Export final

El export final multi-fase **sigue sin implementar**, igual que el export final
de vídeo. Este ADR no lo implementa, no lo planifica y no afirma que exista.

Sí fija una condición para cuando se aborde: la evidencia de una Protection
Session multi-fase **no es concatenable en un único archivo**, y su export
tendrá que preservar el orden temporal y la separación por fases.

---

## 9. Riesgos abiertos

### `RIESGO ABIERTO · GAP DE TRANSICIÓN VÍDEO → AUDIO`

Existe un intervalo entre el instante en que el vídeo deja de producir evidencia
útil y el instante en que el audio empieza a producirla. El micrófono queda
retenido en exclusiva por el productor de vídeo hasta su liberación, de modo que
las dos fases **no pueden solaparse**.

```
Este gap NO es un comportamiento aceptado.
Este gap NO es un presupuesto de diseño.
NO existe todavía una cifra máxima tolerable.
```

**G5 deberá medirlo por contenido**, no por eventos de registro:

```
último instante de evidencia ÚTIL de vídeo
    →  primer instante de evidencia ÚTIL de AUDIO_ONLY
```

Medir por contenido es obligatorio y no es equivalente a medir entre eventos de
ciclo de vida. El último fotograma escrito precede a la liberación del
productor, y el primer audio útil sucede al arranque efectivo del grabador: el
gap real será **mayor** que cualquier intervalo entre eventos de *release*. Es
el mismo criterio que
[`ADR-VIDEO-NATIVE-SEGMENTATION`](./ADR-VIDEO-NATIVE-SEGMENTATION.md) ya impone
para `C-AC4`: un hueco se mide en contenido ausente.

Sólo con esa medición se decidirá qué máximo es aceptable. Una implementación
provisional puede tolerar el gap **con finalidad experimental**; Continuous
Protection no lo canoniza.

> La observación incidental de H-1A —un intervalo entre eventos de *lifecycle* y
> de *release*— **no es el gap de evidencia** y no debe citarse como tal.

### `RIESGO ABIERTO · TERMINALIDAD DIFERIDA`

Diferir la terminalidad hasta PARAR alarga la ventana durante la cual una sesión
permanece abierta. Una Protection Session larga interrumpida de forma anómala
permanece no terminada durante más tiempo del que hoy es posible. El contrato de
recovery deberá cubrirlo (§6).

### `DEUDA ARQUITECTÓNICA · EL ARRANQUE FUERZA TERMINALIDAD` — reservada a G7

El arranque en frío cierra hoy **toda** entrada persistida que encuentre abierta,
sin condición. Es comportamiento **vigente y preexistente**, anterior a este ADR,
y **no se modifica en esta reconciliación**.

Es coherente con el modelo actual —tras un arranque en frío ninguna entrada
persistida sigue capturando— pero **no constituye todavía el recovery que
Continuous Protection requiere**: §2 exige que una terminación anómala no se
interprete automáticamente como un PARAR del usuario, y esa ruta hace
exactamente eso.

```
NO es un defecto corregido.
NO es una capacidad implementada.
Queda reservada al gate G7 — recovery de Protection Session multifase.
```

La referencia operativa vive **en el código**, junto a la escritura afectada.
Aquí sólo consta la deuda arquitectónica y cuál es su gate propietario.

### `RIESGO ABIERTO · SEÑAL DE VISIBILIDAD`

La política de §3 depende de detectar con fiabilidad la pérdida real de
visibilidad. Interrupciones transitorias que el sistema operativo reporte como
pérdida de visibilidad, sin serlo para el usuario, producirían oscilación entre
fases. La distinción entre pérdida real y transitoria debe resolverse en el
diseño y verificarse en hardware.

---

## 10. Diferido, no rechazado

```
AUDIO_ONLY → foreground → VIDEO_AUDIO          DEFERRED
```

El retorno automático a vídeo al recuperar la visibilidad **queda DEFERRED**.
No está rechazado: es plausible y probablemente deseable como UX final.

Se difiere porque el caso esencial —`VIDEO_AUDIO → background → AUDIO_ONLY →
PARAR`— resuelve por sí solo el problema de supervivencia, mientras que el
retorno multiplica los estados a validar y añade un segundo gap de transición
sin haberse medido todavía el primero.

Se evaluará por separado, después de G5, y sólo si puede añadirse sin introducir
complejidad ni huecos de captura.

---

## 11. Alcance: qué promete Continuous Protection y qué no

### Promete

```
· que la protección no se interrumpe al minimizar la aplicación
  ni al bloquear la pantalla
· que la evidencia ya capturada nunca se pierde en una transición de fase
· que las subidas continúan con independencia de la fase
· que el usuario no decide nada durante una transición
· que una sola acción —PARAR— cierra la protección
```

### No promete

```
· captura de vídeo en segundo plano                    PROHIBIDA (§3)
· retorno automático a vídeo al volver al foreground   DEFERRED (§10)
· ausencia de gap entre fases                          RIESGO ABIERTO (§9)
· export final multi-fase                              NO IMPLEMENTADO (§8)
· evidencia mixta descrita por el backend              BLOQUEADA (§7)
```

---

## 12. Lo que este ADR no hace

```
NO implementa nada
NO decide la representación técnica de `producer closed ≠ session closed`
NO introduce nombres de campo, estados de almacenamiento ni esquema
NO autoriza tocar el uploader, el worker, la cola ni el chunking
NO autoriza tocar D3
NO autoriza cambios en el backend ni en la API
NO promueve ninguna capacidad a implementada ni a validada
NO cambia el veredicto NO APTO PARA RELEASE
NO cambia el estado de ningún finding abierto
```

### Sobre la evidencia que originó este ADR

La ejecución `H-1A` del 2026-08-25 observó, en una sola ejecución y un solo
dispositivo, dos comportamientos:

```
SAFE FOREGROUND→BACKGROUND VIDEO SHUTDOWN     observado
CONTINUED UPLOAD IN BACKGROUND                observado
```

Es **evidencia provisional**, no congelada, y **no acredita Continuous
Protection**: en aquella ejecución no existió fase `AUDIO_ONLY` alguna —la
Protection Session terminó al cerrarse el productor de vídeo, que es
precisamente el comportamiento que este ADR sustituye.

No promueve ninguna capacidad a implementada ni a validada.
