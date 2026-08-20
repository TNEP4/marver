# Copy - interface language that works

Read the whole interaction path, never isolated strings. For each state, decide the
message hierarchy before writing: (1) the ONE fact the user needs now, (2) the action
available next, (3) context that changes the decision, (4) the tone this moment
earns. Say each idea once - a heading that explains the state makes the intro under
it redundant.

## By function

**Actions.** Consequential actions get a specific verb + object ("Publish post",
not "Submit"); labels describe what WILL HAPPEN, not the gesture. Navigation names
its DESTINATION ("Settings", not "View Settings"). Same noun and verb for the same
concept everywhere - interfaces never vary words for literary effect. Destructive
actions name the object and the consequence; prefer undo over confirmation when
recovery is safe; when confirming, the button repeats the action ("Delete board"),
never "Yes"/"OK".

**Forms.** Persistent labels - placeholders are examples, never labels. Format and
eligibility requirements BEFORE submission, next to the field. Validation says what
needs attention and how to fix it, without blaming. Required/optional treatment is
consistent across the product.

**Errors.** An actionable error answers: what failed; why, when known AND useful;
how to recover or what alternative remains. No internal codes as the headline. Never
promise a cause the system cannot know. Privacy, payment, deletion, and blocked work
get gravity - warmth is welcome, jokes are not.

**Loading / empty / success.** Loading names the real operation; never invent
progress. Empty states are five DIFFERENT states - first use, cleared, no results,
no permission, failed to load - each with its own explanation and next action.
Success confirms the outcome; mention the next consequence only when it changes what
the user should do; routine success stays brief.

**Help.** Helper text answers an implicit question, never restates the control.
Link text makes sense out of context. Icon-only controls carry accessible names.

## Cadence tells (generated-copy tics to sweep)

Em dashes sprinkled through body copy; manufactured-contrast aphorisms closing
sections ("It's not X. It's Y."); dismissing things as "theater"; generic SaaS
buzzwords ("supercharge", "seamless", "unlock"); the same label repeated in several
slots of one card. Plain sentences in the product's own vocabulary beat all of these.

## Voice and resilience

Voice stays constant; tone adapts to the moment's stakes. Plain language without
flattening terminology the audience genuinely knows. Complete translatable sentences,
never concatenated fragments. Allow for text expansion instead of pre-abbreviating.
Alt text conveys the image's information (empty alt for decoration).

## Verify

Read the flow aloud in context: comprehensible without insider knowledge; actionable
at every error and empty state; terminology consistent; survives long names and 200%
zoom; tone proportional to consequence. The final copy is as short as it can be
without losing meaning or recovery.
