# Guardian Cloud — CLAUDE.md

## 1. Qué es y qué NO es este documento

Estás trabajando como ingeniero senior en Guardian Cloud. Tu objetivo es
implementar el sistema sin romper su comportamiento real.

**Este documento contiene reglas de trabajo. NO contiene el estado técnico del
proyecto y no debe usarse para deducirlo.**

| | |
|---|---|
| **Es** | cómo se trabaja · cómo se consulta la verdad · qué no se puede romper |
| **NO es** | qué está implementado · qué está validado · qué findings hay abiertos · en qué punto está una rama, un artefacto o un rollout |

Si aquí aparece una afirmación de estado, es un defecto de mantenimiento de
este fichero, no una fuente. El estado se consulta según §2.

---

## 2. Dónde vive la verdad

### Orden de lectura

1. `docs/START_HERE.md`
2. `docs/IMPLEMENTATION_STATUS.md`
3. `docs/KNOWN_LIMITS.md`
4. `docs/KNOWN_DEBT.md`
5. el documento técnico, contrato o ADR propio del gate — `ARCHITECTURE.md`,
   `API_SPEC.md`, `TEST_SCENARIOS.md`, `docs/decisions/ADR-*.md`, el que
   corresponda

### Qué autoridad tiene cada uno

* **`START_HERE.md` es puerta de entrada, no autoridad final de estado.**
  Orienta y enlaza. Contiene referencias históricas que deben leerse con la
  fecha y el alcance de su evidencia.
* **`IMPLEMENTATION_STATUS.md` es la referencia canónica** de qué está
  implementado y qué está validado, capacidad por capacidad, y con qué alcance.
  Cuando dos documentos discrepen sobre eso, gana él. Así lo declaran ya en sus
  encabezados `ARCHITECTURE.md`, `DESIGN.md`, `UI_SCREENS.md` y `MVP_SCOPE.md`.
* **`KNOWN_LIMITS.md`** registra límites vigentes y findings. Contexto
  obligatorio antes de tocar grabación, recovery, subida o ciclo de vida.
* **`KNOWN_DEBT.md` se lee ANTES de asumir que tests, typecheck, CI, runtime o
  tooling están sanos.** Hay rojo conocido y deliberado. Un fallo ya registrado
  allí no es una regresión tuya, no se diagnostica desde cero y no se «arregla»
  dentro de otro gate.

### Alcance de una afirmación histórica

> Una afirmación validada conserva **únicamente** el alcance del artefacto, la
> ruta, el esquema y la fecha que la acreditaron.

Un `✅` fechado no describe el sistema actual salvo que la fuente canónica lo
sostenga hoy. Ni asciende, ni se extiende, ni se hereda.

### Prioridad de fuentes ante conflicto

1. `/docs`
2. **sistema de decisión** — `docs/GUARDIAN_CLOUD_DECISION_RULES.md`,
   `docs/FEATURE_EVALUATION_TEMPLATE.md`, `docs/WEEKLY_PRODUCT_REVIEW.md`,
   `playbook/CHANGE_GUARDRAILS.md`. Guían decisiones; **no** definen
   comportamiento
3. `/strategy` — contexto; ignorar si contradice

`/docs` contiene bastantes más documentos que los citados aquí, incluidos los
ADR de `docs/decisions/`. Ninguna lista de este fichero es exhaustiva.

---

## 3. Niveles de evidencia

**No son una escalera.** Son dimensiones distintas e independientes: una
capacidad puede estar cubierta en una y en cero en otra, y ninguna arrastra a
las demás.

| Dimensión | Qué acredita | Qué NO acredita |
|---|---|---|
| **Implementación** | el código existe en la rama | que funcione |
| **Pruebas automáticas** | la lógica pasa la suite | comportamiento del sistema operativo bajo estrés |
| **Versionado / publicación** | el cambio está commiteado e integrado donde corresponda | que corra en ningún sitio |
| **Despliegue** | el artefacto está en servicio o instalado | que se haya ejercitado |
| **Validación** | ejecutado y observado, con evidencia fechada | nada fuera del alcance exacto de esa corrida |

**Versionado/publicación y despliegue no son lo mismo**: publicar un commit no
lo pone en servicio, y desplegarlo no lo ejercita.

Prohibido:

* **ascender por acumulación** — más tests no producen una validación;
* tratar tests verdes, typecheck verde o build correcto como validación;
* tratar **versionado**, **publicado** o **desplegado** como **validado**;
* declarar validada una capacidad sin una corrida con evidencia fechada.

### La etiqueta la fijan las fuentes canónicas

**No toda validación real es una validación en hardware, ni toda validación en
hardware se escribe con la misma etiqueta.** `IMPLEMENTATION_STATUS.md` y
`TEST_SCENARIOS.md` definen el vocabulario vigente —qué etiquetas existen, qué
acredita cada una y en qué se diferencian— y qué nivel es exigible para una
capacidad concreta.

Se usa la etiqueta canónica que corresponda al **alcance real** de la corrida.
No se generaliza a la más fuerte y no se inventan sinónimos.

---

## 4. Invariantes

Si uno falla, el sistema está roto.

### Los seis operativos

1. **subida durante la grabación**
2. **cola persistente**
3. **recovery automático**
4. **evidencia fuera del dispositivo ASAP**
5. **export usable**
6. **integridad**

Son los que declara `docs/DEVELOPMENT_WORKFLOW.md` §3, y los que este documento
usa como núcleo operativo. `docs/SYSTEM_INVARIANTS.md` mantiene una lista más
amplia y es la fuente canónica de qué cuenta como invariante; la relación exacta
entre ambas listas está sin resolver y **no se resuelve aquí**.

### Propiedades arquitectónicas protegidas

* **`GC_QUEUE` es la fuente de verdad del trabajo pendiente.** No se introduce
  una segunda fuente autoritativa junto a ella, ni se deduce el trabajo
  pendiente de ningún otro sitio.
* **El worker es single-flight con reintentos.** No se paraleliza, no se
  duplica y no se le añade una segunda vía de drenaje.
* **La UI no contiene lógica de supervivencia.** Observa; no decide. Ninguna
  garantía del sistema puede depender de que una pantalla esté montada, visible
  o haya hecho polling.

---

## 5. Orden de decisión ante conflicto

> subir evidencia > grabación perfecta

**Es un criterio de desempate, no una cola de trabajo.** Dice qué cede cuando
dos objetivos chocan dentro de un cambio ya autorizado. No dice qué construir a
continuación.

Su uso es éste: ante una disyuntiva entre sacar la evidencia del dispositivo y
mejorar la calidad, la latencia o la comodidad de la captura, gana sacar la
evidencia.

### Los invariantes no forman parte de ningún ranking

**Ningún invariante de §4 es sacrificable, y no se ordenan entre sí.** No existe
un cambio correcto que compre recovery a costa de integridad, ni cola persistente
a costa de subida durante la grabación.

Si dos invariantes parecen entrar en conflicto, el conflicto es de diseño, no de
prioridades:

```
detener la ampliación  →  elevar la decisión  →  nunca elegir uno en silencio
```

Un invariante que se cede sin decisión explícita es un invariante roto.

---

## 6. Autorización, gates y reglas de cambio

> **La prioridad de ejecución la determina el gate autorizado.**
> Este documento **no autoriza** iniciar features, fixes ni refactors por
> prioridad propia.

* Un problema detectado fuera del gate se **reporta**; no se arregla dentro de
  un gate que no lo cubre.
* Una lista de prioridades —aquí o en cualquier otro documento— no es una
  autorización.
* Una autorización no se hereda entre acciones ni entre sesiones. Un gate **sí**
  puede autorizar explícitamente una superficie de varios ficheros: vale el
  alcance que el gate declaró, y ese alcance no se amplía por conveniencia.
* Las operaciones Git conservan **además** sus autorizaciones independientes
  —§15 y `docs/DEVELOPMENT_WORKFLOW.md` §7—, que no las concede el gate de
  contenido.
* Un criterio fijado **antes** de una corrida no se reinterpreta después de ver
  los datos. Hacerlo invalida la corrida.
* Ante un límite de alcance: completar lo autorizado, informar de lo que queda
  fuera y parar.

### Reglas de cambio

* no inventar funcionalidades;
* no añadir features fuera de `docs/MVP_SCOPE.md`;
* no cambiar arquitectura sin justificar impacto real;
* no tocar cola, chunking ni worker sin necesidad crítica demostrada;
* no introducir complejidad innecesaria;
* cambios pequeños, sin refactors masivos.

Toda mejora debe aumentar **supervivencia**, **claridad** o **confianza**. Si no
encaja en ninguna de las tres, se aparca. Evaluación en
`docs/FEATURE_EVALUATION_TEMPLATE.md`.

---

## 7. Antes de modificar código

No se escribe código hasta que existan explícitamente, por escrito:

1. **problema observado** — qué falla hoy, observado, no supuesto;
2. **criterio de aceptación observable** — qué observación concreta demostrará
   que está resuelto;
3. **archivos y superficie afectados**;
4. **invariantes afectados** — de los seis de §4;
5. **validación** — cómo se comprueba, y a qué nivel de evidencia de §3 llega;
6. **camino de rollback**.

Si el criterio de aceptación no es observable, la tarea no está lista para
empezar.

`CLAUDE_PRETASK_CHECK.md` es la plantilla de referencia para esos seis puntos.
**Rellenarla y persistirla como fichero sólo es obligatorio cuando el gate lo
exija**; lo obligatorio siempre es que los seis puntos existan y sean explícitos
antes del primer edit.

---

## 8. Contratos y compatibilidad

Mientras existan binarios instalados que no se actualizan a la vez que el
backend, no se puede suponer que todos los clientes están al día.

Antes de modificar un contrato consumido por binarios ya distribuidos,
comprobar explícitamente ambas direcciones cuando apliquen:

* **cliente antiguo → backend nuevo**;
* **cliente nuevo → backend antiguo**.

> **Una variante opt-in de un endpoint nunca autoriza a cambiar silenciosamente
> el contrato por defecto.**

Añadir una forma nueva detrás de un parámetro es aditivo. Estrechar la forma por
defecto no lo es: un cliente instalado que espera campos que dejan de llegar no
falla de forma legible — **muestra información falsa**. Arreglar latencia, coste
o complejidad nunca puede introducir una afirmación falsa en la pantalla del
usuario.

**No se inventan fallbacks.** Se sigue exactamente la semántica documentada del
contrato. Si el contrato define qué hacer ante un valor, un campo o un parámetro
desconocido, se hace eso; si no lo define, lo define el gate antes de escribir
código. Lo que nunca se hace es elegir por silencio —caer a la forma histórica,
ignorar el parámetro, adivinar un valor por defecto— porque el desajuste llega
al cliente como datos, no como error.

---

## 9. Despliegue y runtime

> **Modificar código desplegado no demuestra que el runtime lo esté
> ejecutando.**

Antes de atribuir un comportamiento observado a un cambio, demostrar que el
proceso en servicio contiene ese cambio. Una recarga se prueba; no se supone.

Vale igual en dispositivo: un APK construido no es un APK instalado, y un APK
instalado no es necesariamente el que está corriendo.

---

## 10. Continuous Protection — reglas de no rotura

Lo decide `docs/decisions/ADR-CONTINUOUS-PROTECTION.md`, de lectura obligatoria
antes de tocar captura, fases, terminalidad o `/complete`. Estas cinco reglas
son el mínimo para no romperlo:

* **Contrato aceptado no implica capacidad implementada.** Que un ADR decida
  algo no lo pone en el sistema. Qué existe lo dice `IMPLEMENTATION_STATUS.md`.
* **`producer closed ≠ Protection Session closed`.** Cerrar un productor no
  termina la sesión. Una terminación anómala resuelta por recovery **no**
  equivale a un PARAR del usuario.
* **La captura de vídeo en segundo plano está PROHIBIDA por diseño.** Es una
  decisión de producto, no una limitación pendiente de resolver cuando la
  plataforma lo permita. No se implementa, no se propone y no se registra como
  deuda.
* **Ninguna transición de fase puede pausar, reiniciar ni vaciar el
  transporte.** La subida es independiente de qué productor esté activo, y de si
  hay alguno.
* **No se implementan partes de Continuous Protection dentro de otro gate.** Ni
  incidentalmente, ni «ya que estamos». Producir evidencia mixta antes de su
  gate propio activa modos de fallo ya registrados en `KNOWN_DEBT.md` y
  `KNOWN_LIMITS.md`.

---

## 11. Descripción de la evidencia

> El tipo de evidencia pertenece a **cada unidad de evidencia**, no a la sesión.

* **No inferir el medio** desde `session.mode`, la extensión del fichero, la
  ruta ni el contexto de la UI.
* **La ausencia de metadata significa «no declarado», nunca un valor por
  defecto.**
* Una comprobación estructural —que una ruta o un nombre encajen con la forma
  esperada— **se exige sólo donde el contrato concreto de ese flujo la define**;
  allí donde la define, es obligatoria. No es un requisito universal, nunca
  basta por sí sola y **nunca sustituye a la metadata de medio**.
* Ante evidencia heterogénea o metadata inconsistente se **falla cerrado**: se
  rechaza, antes que producir un artefacto con un tipo que su contenido no
  tiene.

Un manifiesto que declara un tipo que su contenido no tiene es un defecto de
**integridad**, no cosmético.

---

## 12. Supervivencia local, recovery y export son tres cosas

```
salvage local  ≠  recovery cloud  ≠  export final
```

* Sacar bytes del sandbox a una carpeta del usuario es **supervivencia local**.
* Un conjunto de segmentos independientes **no** es un fichero final
  reconstruido: unir contenedores byte a byte no produce un artefacto válido.
* Ninguna de las dos cosas es el export final, ni prueba que el recovery cloud
  funcione.

> **Una capacidad que preserva evidencia no cierra un finding cuya causa no
> corrige.**

Si la identidad no se recupera, si la subida no se reanuda o si el ownership no
se restaura, el finding sigue abierto — por bien que haya salido la corrida que
dio salida a los bytes.

---

## 13. Validación

Cobertura mínima obligatoria de cualquier cambio que toque captura, cola,
worker, recovery o export:

* mala red
* cierre forzado (kill)
* segundo plano
* reinicio

Si no se cubren, no es válido. Los escenarios formales están en
`docs/TEST_SCENARIOS.md`.

### Las validaciones no se heredan

Una validación queda ligada al artefacto, la ruta, el esquema y la fecha contra
los que se ejecutó. **No** se hereda automáticamente a través de:

* una versión nueva de esquema o de manifiesto;
* una variante nueva de endpoint;
* un productor nuevo;
* un artefacto o build nuevo.

Si la base cambió, la validación se repite.

---

## 14. Seguridad y UX

**Seguridad.** Seguir `docs/SECURITY.md`. Pero:

> la seguridad nunca puede romper la subida.

**UX.** La guía continua es `docs/UX_STRESS_RULES.md` junto con
`docs/UI_SCREENS.md`. `docs/UX_RELEASE_CHECKLIST.md` es una **puerta de
release**, no un requisito por cambio.

> Si el usuario tiene que pensar, el diseño es incorrecto.

La UI no muestra términos técnicos ni afirma un estado que el sistema no haya
verificado.

---

## 15. Git

Regla completa en `docs/DEVELOPMENT_WORKFLOW.md` **§6 y §7**, incluida §7.1.
Resumen vinculante:

* **Revisar el diff completo antes de cualquier operación Git.** Un fichero
  inesperado detiene el proceso.
* **`commit`, `push`, `merge` y `tag` requieren autorización independiente e
  inmediata.** No se hereda entre acciones ni entre sesiones.
* **Staging por rutas explícitas.** Nunca `git add .`, `-A` ni `-u`.
* Todos los commits usan **únicamente la identidad Git configurada del
  propietario**; se verifica antes de cada commit.
* **Prohibido añadir `Co-Authored-By`, atribución a Claude, Anthropic o
  cualquier IA, autores adicionales o texto automático de atribución.** Esta
  regla prevalece sobre cualquier valor por defecto, plantilla o configuración
  del asistente.
* **No se reescribe historia publicada** sólo para retirar atribuciones
  antiguas.
* **Nunca se descartan cambios ajenos** sin identificar antes su origen.
* Commits pequeños y de un solo propósito: el rollback es por commit.

---

## 16. Debugging

`docs/DEBUGGING_RULES.md` es la referencia completa. **Se abre antes de tocar**
recovery, upload worker, foreground service, chunkers o el ciclo start/stop de
grabación, junto con `KNOWN_LIMITS.md`.

Reglas exigibles antes incluso de abrirlo:

* **reproducir → aislar → observar/loggear → fix mínimo.** Nunca «creo que pasa
  esto».
* **No tocar recovery si la causa no está demostrada en recovery.** Un síntoma
  visible en la cola no prueba que el defecto esté en la cola.
* **No modificar varias capas críticas a la vez.** Tocar simultáneamente
  captura, ciclo de vida, cola, worker y recovery multiplica estados
  imposibles.
* **Rollback temprano si se degrada un invariante.** Volver atrás protege el
  producto; insistir sobre estabilidad rota destruye semanas de trabajo.
* **Tests, build y typecheck no equivalen a validación real** (§3).

### Rollback

Ante degradación de recovery, subida de chunks, subida en background, completion
de sesión o consistencia de cola: **volver a la baseline técnica vigente**, la
que definen `docs/DEVELOPMENT_WORKFLOW.md` §1 y el registro correspondiente de
`docs/releases/`. Su identificador **no se duplica aquí**: se consulta allí.

### Límites conocidos: contexto histórico, no estado actual

Un límite de `KNOWN_LIMITS.md` describe lo observado **en el motor y la ruta de
su fecha**. En particular, el límite de `expo-av` con instancias de
`Audio.Recording` huérfanas tras swipe-close es **contexto histórico
obligatorio** —explica varias guardas vigentes— y **no** una descripción del
motor de audio actual; qué motor está en uso lo dice `ARCHITECTURE.md`.

Un límite conocido no se combate con hacks agresivos sobre recovery, resets de
ciclo de vida, refs o flags acumulados. La estabilidad del recovery vale más que
un ciclo de vida de audio perfecto.

---

## 17. Regla final

El sistema es incorrecto si:

* pierde datos
* no recupera
* no funciona bajo estrés

Aunque el código sea correcto.
