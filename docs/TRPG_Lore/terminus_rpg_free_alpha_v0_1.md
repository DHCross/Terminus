# TERMINUS RPG — FREE ALPHA

**Version:** Alpha Draft 0.1  
**Status:** Working rules packet  
**Use:** Table play, VTT play, and design testing  
**Former development names:** Lattice / Silhouette  

---

## Designer Note

**Terminus** descends from the earlier Lattice system and the GWSD scene-state framework, but this alpha is not a reprint of either.

From Lattice, Terminus keeps:

- the d4 → d6 → d8 → d10 → d12 die ladder
- front-loaded character creation
- character identity as a real play object, not an afterthought
- techniques / feats evolving into Order Abilities
- battle maps as useful table interfaces

From GWSD, Terminus keeps:

- scenes as active states
- Ground / Will / Shift / Drift
- the Scene Card as the Guide's source of truth
- fiction as executable structure
- pressure over static encounter design

Terminus changes the older engine in several major ways:

- no Ability + Discipline dice pools on the front card
- no default spread of d6s
- no large ablative Guard / Vigor defense pools
- no to-hit rolls
- no passive target numbers
- no generic adventurers' guild premise
- no visible “simulation” language for players

The current alpha engine uses **paired Skill / Threshold dice**.

---

# 1. What This Alpha Is

This is a public alpha for **Terminus**, a dark fantasy tabletop roleplaying game with high fantasy overtones.

Terminus is about characters trained, marked, licensed, or forced to respond when stable reality begins to fail.

The game is built around three linked ideas:

1. **Routine stabilizes reality.**
2. **Rupture is systemic failure.**
3. **Orders exist because ordinary institutions cannot respond fast enough.**

This alpha is meant to test:

- whether the character card is readable
- whether paired Skill / Threshold dice work at the table
- whether the no-to-hit conflict loop feels active
- whether Orders feel like playable identities
- whether Scene Cards help the Guide run pressure cleanly

This is not the final rulebook. It is a functional test packet.

---

# 2. The World Under Strain

The world of Terminus is not chaotic. It wants stability.

Routine is cheap. Predictability is efficient. Repetition keeps the world quiet.

A transit line arriving exactly on the minute, a market opening in the same order every morning, a factory whistle sounding at the same hour, a priest reciting the same civic blessing over the same stones — these are not just cultural habits. They are stabilizing patterns.

When the world is healthy, people are allowed to be ordinary.

They walk, eat, bargain, quarrel, read, sleep, and love without testing their thresholds. The air is light. The day proceeds. The system accepts life without resistance.

A **Rupture** begins when routine fails.

It may begin as a repeated footstep, a signal that changes out of order, a door that opens into the wrong room, a person answering a question before it is asked, or a street that remembers a different city.

The Orders are not formed to seek adventure. They are formed because some failures cannot be handled by law, craft, money, violence, prayer, or scholarship alone.

When a situation cannot be stabilized, contained, understood, negotiated, broken, or escaped by one method, multiple Orders are sent.

That is why player characters work together.

---

# 3. Core Dice

Terminus uses five die ranks:

| Rank | Die |
|---:|:---|
| 1 | d4 |
| 2 | d6 |
| 3 | d8 |
| 4 | d10 |
| 5 | d12 |

Each character has three **Skills**:

| Skill | Covers |
|---|---|
| **Force** | impact, strength, breaking through, bodily pressure, overpowering |
| **Agility** | movement, timing, evasion, coordination, finesse, responsive precision |
| **Willpower** | resolve, concentration, inner control, fear resistance, sustained intent |

Each Skill also creates a linked **Threshold**.

| Skill | Threshold | Direction |
|---|---|---|
| Force | Endure | act with force / take force |
| Agility | Avoid | act with movement / evade pressure |
| Willpower | Exert | act through resolve / spend inner strain |

This is the core rule:

> **Skills and Thresholds are the same engine. Acting uses the Skill side. Resisting uses the Threshold side.**

---

# 4. Threshold Circles

Thresholds are not large defense pools.

Each Threshold has a small number of circles derived from its linked Skill die.

| Skill Die | Threshold Circles |
|---|---:|
| d4 | 1 |
| d6 | 2 |
| d8 | 3 |
| d10 | 4 |
| d12 | 5 |

Example:

| Skill | Die | Threshold | Circles |
|---|---|---|---:|
| Force | d10 | Endure | 4 |
| Agility | d8 | Avoid | 3 |
| Willpower | d6 | Exert | 2 |

Threshold circles are spent, marked, lost, or pressured during play. Losing a circle should matter. Breaking a Threshold should change the situation.

---

# 5. The Character Card

The front-facing character card should show only what matters during active play.

## Card Front

```text
NAME
SPECIES
ORDER
APPROACH
SIGNATURE

SKILLS
Force       d__
Agility     d__
Willpower   d__

THRESHOLDS
Endure      ○ ○ ○ ○ ○
Avoid       ○ ○ ○ ○ ○
Exert       ○ ○ ○ ○ ○

ORDER ABILITIES
Ability I
Ability II
Ability III
```

The card is not a complete biography. It is the runtime face of the character.

## Card Back or Support Sheet

The second card or support sheet may hold:

- background
- equipment
- weapon details
- armor
- spell construction notes
- extra Order Abilities
- advancement
- contacts
- debts
- conditions
- notes

---

# 6. Character Creation

Character creation is front-loaded. The player builds a complete character before play begins.

## Step 1 — Choose Species

Species gives origin, body, inheritance, and one or two small tendencies or exceptions.

Species should not replace Order identity.

Starter alpha Species:

- Human
- High Alfar
- Deep Alfar
- Wild Alfar
- Stoneborn

## Step 2 — Choose Order

Order is the character's recognized field-response identity.

Orders are not desk professions. They are responses to instability.

Starter alpha Orders:

| Order | Field Function |
|---|---|
| Seeker | reveals what is hidden |
| Breaker | forces openings and ruptures |
| Warden | holds collapse at bay |
| Rival | wins contests of timing, leverage, and momentum |
| Broker | turns agreement, obligation, and faction pressure into action |
| Shade | moves through secrecy, misdirection, and reversal |

## Step 3 — Choose Approach

Approach is chosen from a menu provided by the Order.

Approach tells the table how the character usually expresses pressure.

Example approaches:

- Reveal
- Sever
- Anchor
- Redirect
- Overwhelm
- Bind
- Slip
- Challenge

## Step 4 — Choose Signature

Signature is the character's defining item.

It may be a weapon, focus, tool, relic, heirloom, mask, seal, instrument, grimoire, lantern, ring, blade, staff, or civic token.

A Signature is not just decoration. It is the object that makes the character legible in play.

## Step 5 — Assign Skill Dice

All three Skills begin at d4.

The alpha assumes **5 build steps** to distribute among Force, Agility, and Willpower.

Each step raises one Skill by one die rank.

Die ladder:

```text
d4 → d6 → d8 → d10 → d12
```

No Skill may rise above d12 at character creation.

Example spreads:

| Concept | Force | Agility | Willpower |
|---|---|---|---|
| Brawler | d12 | d6 | d4 |
| Skirmisher | d6 | d12 | d4 |
| Tactician | d6 | d8 | d8 |
| Balanced | d8 | d8 | d6 |
| Warden | d10 | d6 | d8 |
| Shade | d4 | d12 | d6 |
| Seeker | d4 | d8 | d10 |

## Step 6 — Derive Thresholds

Use each Skill die to set the matching Threshold circles.

| Skill | Threshold |
|---|---|
| Force | Endure |
| Agility | Avoid |
| Willpower | Exert |

## Step 7 — Choose Three Order Abilities

Order Abilities are simplified descendants of older feat-style powers.

They are not passive flavor. They are permissions, exceptions, or specific ways the Order bends the action grammar.

Each starting character chooses three.

## Step 8 — Choose Equipment

At minimum, choose:

- one primary weapon or tool
- one secondary item
- one armor or protection type if appropriate
- one Signature item

## Step 9 — Name the Character

Add:

- name
- one sentence of background
- one current objective
- one thing the character will risk

That is enough to play.

---

# 7. Species

## Human

Humans are the most adaptable lineage.

They dominate many civic structures because they bend without needing to belong to older systems.

Suggested alpha trait:

**Flexible Training:** Once per scene, step up one Skill roll by one die if the action fits your Order.

## High Alfar

High Alfar are tied to old structures, formal Orders, civic memory, and stable high magic.

They remember how the world was supposed to work.

Suggested alpha trait:

**Old Law:** When acting within a formal institution, sealed place, oath-bound site, or ancient civic structure, step up one Willpower or Exert roll.

## Deep Alfar

Deep Alfar are tied to hidden layers, buried systems, and the pressure beneath visible reality.

They perceive what others miss.

Suggested alpha trait:

**Under-Sight:** Once per scene, ask the Guide what hidden pressure, ward, flaw, or instability is present.

## Wild Alfar

Wild Alfar are tied to motion, fracture, edge-zones, and places where stability is already weakening.

They thrive where systems slip.

Suggested alpha trait:

**Fracture Step:** When the scene is unstable, step up one Agility or Avoid roll.

## Stoneborn

Stoneborn are not constructs. They are people shaped by enduring environments and old structural memory.

They change slowly and break slowly.

Suggested alpha trait:

**Hard Memory:** Once per scene, ignore the first lost Endure circle from environmental pressure, collapse, crushing force, or forced movement.

---

# 8. Orders

Orders are social powers, field roles, and play identities.

They are not ordinary jobs. A Seeker behind a desk is already too late. A Warden who never enters danger is only a symbol. A Broker who negotiates only in safe rooms is not doing Order work.

Orders exist because stable systems cannot resolve rupture remotely.

## Seeker

Seekers reveal what is hidden, buried, misremembered, false, sealed, or waiting.

They are not scholars by default. They are field readers of unstable truth.

Suggested approaches:

- Reveal
- Trace
- Name
- Expose
- Interpret

Suggested Signatures:

- lantern
- lens
- grimoire
- marked coin
- relic key
- archive seal

Starter Order Abilities:

**Weak Point**  
After you study a target, object, or scene feature, name one way it can be pressured.

**Trace Source**  
When you examine a pressure, working, wound, or relic, you may ask where it came from.

**Bring to Light**  
You can reveal a hidden object, path, ward, person, motive, or weak point if you can reach evidence of it.

**Read the Pattern**  
After you observe a repeated behavior or routine, your next action against it cannot be surprised by that routine.

## Breaker

Breakers force openings.

They are breach-makers, saboteurs, duelists, siege minds, liberators, and dangerous tools when containment fails.

Suggested approaches:

- Shatter
- Sever
- Breach
- Overwhelm
- Unmake

Suggested Signatures:

- hammer
- axe
- blade
- iron rod
- demolition charm
- broken standard

Starter Order Abilities:

**Breach Point**  
When you damage a barrier, lock, ward, shield, or formation, you may also open a temporary passage or gap.

**Overrun**  
When you win with Force, you may drive the target back, knock it aside, or break its position.

**Break the Tool**  
You may target a weapon, focus, ward-anchor, brace, chain, or mechanism instead of the wielder.

**Carry the Break**  
When something breaks, you may push part of that break into an adjacent object, target, or position.

## Warden

Wardens hold the line.

They are not guards. They are field anchors sent where collapse is already in motion.

Suggested approaches:

- Anchor
- Shield
- Hold
- Interpose
- Contain

Suggested Signatures:

- shield
- staff
- oath-chain
- ward-stone
- field standard
- iron-bound mantle

Starter Order Abilities:

**Hold the Line**  
When a nearby ally would lose a Threshold circle, you may take that loss instead if you can plausibly interpose.

**Anchor Point**  
Choose one position, door, bridge, threshold, or boundary. Until you move, it is harder to force open, cross, or collapse.

**Brace Against It**  
When you choose Endure, you may protect one nearby person or object from the same pressure.

**No Further**  
When an enemy tries to pass your position, you may force them to deal with you first.

## Rival

Rivals live inside contests.

They turn races, duels, wagers, chases, comparisons, and public pressure into leverage.

Suggested approaches:

- Challenge
- Outpace
- Answer
- Match
- Humiliate

Suggested Signatures:

- dueling blade
- marked glove
- racing token
- trophy
- challenge writ
- mirrored charm

Starter Order Abilities:

**Call the Contest**  
Name the terms of a contest clearly. If the other side accepts or answers, both sides are bound to those terms until someone breaks them.

**Outpace**  
When timing matters, you may force a direct contest before the other side completes its move.

**Turnabout**  
When an opponent fails against you, you may immediately change position, claim leverage, or put them under pressure.

**Public Measure**  
When others are watching, your victory or failure changes how the crowd, faction, or witness treats the scene.

## Broker

Brokers turn obligation into motion.

They are not desk diplomats. They work where agreements are unstable and leverage must be applied now.

Suggested approaches:

- Bind
- Trade
- Pressure
- Reframe
- Collect

Suggested Signatures:

- contract case
- seal ring
- ledger
- marked scales
- debt chain
- witness token

Starter Order Abilities:

**Call in Favor**  
Introduce one plausible contact, owed service, minor resource, or old arrangement into the scene.

**Make Terms**  
When two sides can hear you, you may propose terms that change what each side is willing to risk.

**Hold the Debt**  
When someone accepts your help, mark the obligation. Later, you may ask for repayment in a related scene.

**Turn the Room**  
When you reveal leverage, you may shift one neutral, hesitant, or self-interested NPC toward action.

## Shade

Shades work through access, concealment, misdirection, and reversal.

They do not merely hide. They pass through the places where attention fails.

Suggested approaches:

- Slip
- Veil
- Misdirect
- Reverse
- Vanish

Suggested Signatures:

- mask
- cloak
- lockpick set
- black knife
- false papers
- mirrored pin

Starter Order Abilities:

**Unmarked Entry**  
If no one is directly watching the point of entry, you may enter without immediately becoming the scene's focus.

**False Trail**  
Leave evidence that points attention, suspicion, or pursuit somewhere else.

**Slip the Boundary**  
You may pass through a guarded, watched, or socially restricted space if you can name the gap in attention.

**Turn It Back**  
When someone uses deception, concealment, or misdirection against you, you may redirect part of that confusion toward them.

---

# 9. Conflict and Pressure

Terminus does not use to-hit rolls.

An attack is not a request for permission to matter. The action matters. The question is how the target takes it.

## Core Exchange

```text
1. Acting side chooses Force, Agility, or Willpower.
2. Responding side chooses Endure, Avoid, or Exert.
3. Both roll.
4. Higher roll takes control of the exchange.
5. Effect, Impact, or Vector resolves.
6. The losing side routes the consequence through the chosen Threshold.
```

There is no target number.

There is no passive defense score.

The opponent rolls because the opponent is active.

## Skill / Threshold Pairing

| Acting Skill | Resisting Threshold |
|---|---|
| Force | Endure |
| Agility | Avoid |
| Willpower | Exert |

The responding side is not required to choose the matching Threshold. A target may answer Force with Avoid, or Agility with Exert, if the fiction supports it.

## Endure

Use Endure when you take pressure directly.

Endure may mean:

- absorbing impact
- bracing
- holding the line
- taking the blow
- staying upright
- letting the pressure hit body, armor, shield, or mass

Losing Endure circles means the character is being worn down or physically pressured.

## Avoid

Use Avoid when you refuse the pressure by movement, timing, distance, or position.

Avoid may mean:

- dodging
- slipping
- falling back
- giving ground
- breaking line of sight
- losing position to avoid worse harm

Losing Avoid circles means the character is running out of clean exits, timing, or safe angles.

Avoid consequences may include:

- driven back
- exposed
- separated
- cornered
- prone
- disarmed
- delayed
- cut off

## Exert

Use Exert when you spend inner force to keep control.

Exert may mean:

- forcing concentration
- resisting fear
- holding a working together
- pushing through pain
- keeping command under pressure
- refusing hesitation

Losing Exert circles means the character is burning internal reserve.

Exert is powerful, but limited.

## Ties

Default alpha rule:

**Ties favor the responding side.**

Optional test rule:

**A tie means neither side takes full control, but the scene pressure increases.**

Use one rule consistently during a playtest.

## Maximum Rolls

Optional alpha rule:

If a die rolls its maximum face, the action may trigger a Vector, Order Ability, or Signature effect if one applies.

Do not build the whole system around critical hits yet. Test this lightly.

---

# 10. Weapons, Tools, and Vectors

Weapons and tools define what kind of pressure is delivered when control is won.

A weapon has:

- **Impact** — how much pressure it applies
- **Vector** — what special property it carries

Starter examples:

| Weapon / Tool | Impact | Vector |
|---|---:|---|
| Unarmed | 1 | none |
| Knife | 1 | armor-piercing |
| Short sword | 2 | quick |
| Longsword | 2 | balanced |
| Spear | 2 | reaches position |
| Crossbow | 2 | armor-piercing |
| Greataxe | 3 | hard to Avoid |
| War hammer | 3 | breaks protection |
| Staff | 1 | reach / warding |
| Shield | 1 | protects position |

Impact values are provisional.

Avoid making weapons carry the whole excitement of combat. The interesting choice should come from the exchange, the Threshold response, Order Abilities, and scene pressure.

---

# 11. Checks Formerly Called Saving Throws

Terminus does not need separate saving throw stats on the card.

Instead, emergency checks use the linked Skill.

| Check Type | Roll |
|---|---|
| Heroic check | Force |
| Evasive check | Agility |
| Mental check | Willpower |

Use these only when something bypasses ordinary Threshold play or threatens agency directly.

Examples:

- poison
- paralysis
- domination
- forced sleep
- supernatural fear
- sudden entrapment
- catastrophic collapse
- direct possession
- reality correction

Do not use these for normal attacks.

Normal pressure is handled through Endure, Avoid, and Exert.

---

# 12. Magic and Workings

Magic in Terminus is not a long spell list.

A Working is built from components.

## Working Components

| Component | Question |
|---|---|
| Order | Who has permission to do this? |
| Effect | What kind of change is attempted? |
| Form | How does it appear or move? |
| Reach | How far can it operate? |
| Duration | How long does it hold? |
| State Result | What changes in the scene? |

## Sample Effects

- Harm
- Reveal
- Bind
- Restore
- Protect
- Alter
- Open
- Close
- Move
- Silence
- Mark
- Unmake

## Sample Forms

- touch
- line
- cone
- burst
- circle
- mark
- ward
- voice
- gaze
- object
- threshold

## Sample Reach

- touch
- near
- far
- sight
- named target
- bounded scene
- prepared place

## State Result

A Working must answer what changes.

Examples:

- a hidden pressure becomes visible
- a path opens
- a target loses Endure
- an enemy must Avoid or be pinned
- a ward holds a doorway shut
- a crowd can hear one voice clearly
- fire cannot cross a marked line
- a repeated action breaks its loop

## Map and Scene Card Doctrine

Terminus supports theater of the mind, Scene Cards, and battle maps.

These are not competing authorities.

The battle map tells players where they stand, where the cone lands, how far the burst reaches, and what terrain blocks movement.

The Scene Card tells the Guide what that action is allowed to change.

A spell can be physically wide and state-light. A spell can be physically precise and state-heavy.

The map tells us where it lands.

The Scene Card tells us what kind of change that landing can produce.

---

# 13. Scene Cards

The Scene Card is the Guide's source of truth.

A Scene is not a room. A Scene is an active state.

A new Scene begins only when permissions or pressures change.

## Scene Card Template

```md
# Scene Name

## Ground
What is possible here right now?

## Will
What pressure is already acting?

## Shift
What changes when characters act?

## Drift
What changes if they do nothing?
```

## Ground

Ground defines what actions are possible.

Examples:

- Magic cannot cross the black threshold.
- No one can hear speech beyond arm's reach.
- The bridge supports only one heavy body at a time.
- No one may draw steel without breaking civic law.
- The tram doors open only on every third bell.

## Will

Will defines what is pushing.

Examples:

- The crowd wants the crossing to keep moving.
- The Warden engine is trying to reseal the breach.
- The rival cell wants the witness first.
- The old ward prioritizes children over adults.
- The loop is trying to complete the same event again.

## Shift

Shift defines what changes when characters act.

Examples:

- If someone touches the duplicate tram, both trams become solid.
- If the Seeker names the repeated step, the trapped pedestrian can hear them.
- If the Breaker damages the signal post, the crossing loses timing control.
- If the Broker addresses the crowd, the panic has a voice to follow.

## Drift

Drift defines what changes if characters do nothing.

Examples:

- Each round, another pedestrian enters the repeated step.
- The trams become more solid.
- The crowd compresses toward the center.
- The bells lose one beat of sync.
- The crossing stops accepting new movement.

---

# 14. Starter Scenario — The Timed Crossing

## Premise

A central city crossing runs on perfect civic timing.

Signals change in sequence. Trams arrive on exact intervals. Vendors move with practiced rhythm. People cross without hesitation.

Then the pattern slips.

## Opening Read-Aloud

The crossing is clean, loud, and exact.

The clock above the terminal cuts the minute into brass. A bell sounds. The east signal drops. The south signal rises. The tram glides in on time, doors opening just as the market awnings snap into place.

No one stops. No one collides. No one waits longer than they should.

Then the north signal changes out of order.

One line of pedestrians steps forward.

The other does not stop.

For half a second, everyone notices the same mistake.

Then the bell rings again.

The same bell.

## Scene Card — The Timed Crossing

### Ground

- The crossing is crowded but orderly.
- Movement is governed by signals, bells, tram doors, and civic habit.
- The map shows lanes, platforms, vendor stalls, signal posts, and tram lines.
- Characters may move, speak, intervene, damage objects, direct crowds, or inspect the timing system.

### Will

- The crossing is trying to preserve routine.
- The crowd expects the signals to remain trustworthy.
- The timing system is beginning to desynchronize.
- The first loop is forming around one pedestrian's repeated step.

### Shift

- If characters interrupt the repeated pedestrian, the loop jumps to the nearest signal.
- If characters damage a signal post, the crowd loses confidence in the crossing.
- If characters stabilize the crowd, the loop remains localized for one more round.
- If characters inspect the tram line, they see two trams occupying the same scheduled arrival.

### Drift

At the end of each round, choose or roll:

1. Another pedestrian repeats an action.
2. A signal changes out of sequence.
3. The duplicate tram becomes more solid.
4. The crowd compresses toward the center.
5. A vendor stall appears in two places.
6. The bell rings twice, and one character loses track of which ring came first.

## Order Hooks

- Seeker: You notice the first repeated step before anyone panics.
- Breaker: You see the signal post that could break the loop if destroyed.
- Warden: You are near the crowd line that will collapse first.
- Rival: Someone else is moving before the signal permits it.
- Broker: The crowd needs a voice before it becomes a crush.
- Shade: The desync creates a gap no one else sees.

---

# 15. Playtest Questions

After a session, ask:

1. Did the character card make sense?
2. Did Force / Agility / Willpower feel broad enough?
3. Did Endure / Avoid / Exert create real choices?
4. Did anyone miss separate saving throws?
5. Did the no-to-hit exchange feel active?
6. Did the defender's response choice matter?
7. Did Order Abilities feel like permissions rather than bonuses?
8. Did Species matter enough, too much, or not at all?
9. Did the Scene Card help the Guide?
10. Did the battle map and Scene Card conflict?
11. Did any rule create dead space?
12. What confused the table first?

---

# 16. Known Open Questions

This alpha does not fully solve:

- exact weapon balance
- armor and shield tuning
- monster / creature construction
- advancement
- full magic grammar
- detailed Order menus
- Signature progression
- long-term injury
- recovery timing
- economy and equipment
- exact tie rules
- how scene pressure rolls, if it rolls at all

Do not hide these. Test them.

---

# 17. One-Page Rules Summary

```text
TERMINUS CORE

Skills:
Force
Agility
Willpower

Thresholds:
Force → Endure
Agility → Avoid
Willpower → Exert

Die Ranks:
d4 d6 d8 d10 d12

Threshold Circles:
d4=1
d6=2
d8=3
d10=4
d12=5

Conflict:
Acting side rolls Skill.
Responding side chooses Threshold and rolls.
Higher roll takes control.
No target number.
No to-hit roll.
No passive defense.

Scene Card:
Ground — what is possible?
Will — what pressure is active?
Shift — what changes when characters act?
Drift — what changes if they do nothing?

The map guides players.
The Scene Card guides the Guide.
```

---

# 18. Closing Alpha Note

Terminus is not about adventurers looking for trouble.

It is about people trained to enter the places where ordinary life has stopped working.

The goal is not chaos.

The goal is the return of the quiet day.
