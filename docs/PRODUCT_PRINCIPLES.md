# Guardian Cloud — Product Principles

## 🎯 Objetivo

Definir las reglas que guían todas las decisiones del producto.

---

## 1. Prioridad absoluta

> Subir evidencia > grabación perfecta

Si hay conflicto:

* gana la subida

---

## 2. Simplicidad bajo estrés

El usuario:

* no piensa
* no analiza
* actúa

Regla:

> Si el usuario tiene que pensar, el diseño es incorrecto

---

## 3. Seguridad percibida > features

El usuario no compra funciones.

Compra:

* tranquilidad
* control
* confianza

---

## 4. Funcionar en condiciones reales

El sistema debe funcionar en:

* mala red
* app minimizada
* cierre forzado
* reinicio

Si falla en estos escenarios:

> el producto no es válido

**Qué significa «app minimizada».** Significa que la **protección** debe
continuar: la evidencia ya capturada sigue subiéndose. **No** significa que la
cámara siga grabando. La captura de vídeo es deliberadamente *foreground-only*,
y con la aplicación en segundo plano o la pantalla bloqueada no se autoriza el
uso de la cámara.

> **Dirección aprobada · NO implementada.** Hoy, al minimizar durante una
> captura de vídeo, el productor se detiene de forma controlada y **la sesión
> actual termina**; Continuous Protection cambia ese contrato para que la
> Protection Session permanezca abierta y continúe mediante `AUDIO_ONLY`, sin
> que el usuario decida nada. Decide
> [`decisions/ADR-CONTINUOUS-PROTECTION.md`](./decisions/ADR-CONTINUOUS-PROTECTION.md).

---

## 5. No sobreingeniería

Evitar:

* lógica innecesaria
* abstracciones prematuras
* features no validadas

---

## 6. Validación > ideas

No se implementa nada sin:

* uso real
* feedback real

---

## 7. Control del usuario

* los datos son del usuario
* el almacenamiento es del usuario
* el sistema no retiene evidencia

---

## 8. Regla final

> No romper lo que ya funciona
