---
name: onboard
description: A guided first-day interview that fills Holt's memory with who you are and what you are working on, so recall is useful from day one instead of after weeks of use. Use on a fresh folder, or to top up a thin memory.
---

# onboard

## When to use

Holt is installed but it does not know the user yet. An empty memory makes every
answer generic, which is the most common reason people install Holt and drift
away. This skill front-loads the knowledge that recall needs, in about fifteen
minutes, and ends with one real piece of work.

Also use it when `holt memory` shows very few facts and answers still feel
generic, or when the user starts a new folder for a different part of their life.

## The ladder

Holt gets useful in four rungs, in order. Onboarding is rung one.

1. **Know**: it holds facts about you and your work. (`holt memory`)
2. **Reach**: it can see your real material: files, notes, other tools. (`holt hook`, `holt mcp`)
3. **Do**: it runs your repeated work as skills. (`holt skill`)
4. **Run**: it acts without you being there. (`holt routine`, `holt schedule`)

Do not skip ahead. Automation on top of an empty memory produces confident
nonsense on a timer.

## Instructions

### Before you start

1. Check what is already known: run `holt memory` and, if any facts exist,
   `holt memory facts`. If the folder already holds real facts, say so and offer
   a top-up on the thin areas instead of the full interview. Never re-ask
   something already in memory.
2. Set expectations in two lines: seven questions, about fifteen minutes, and
   they can stop at any point because you save as you go.

### Running the interview

Ask **one question at a time.** Wait for the answer before moving on. Never
present the whole list at once; a wall of questions is the main reason people
abandon setup. Keep your own words short between questions.

Ask for the real thing, never a description of it. "Paste the last update you
sent your team" beats "how would you describe your writing style". Concrete
input is what makes recall work later.

If an answer is thin or abstract, ask one follow-up for a specific name, number,
or example, then move on. Two follow-ups on one question is too many.

The seven questions:

1. **Who you are.** What is your work, and what does a normal day actually
   involve? Get the role, and what they are responsible for.
2. **What is live.** The three to five things genuinely in flight right now, and
   the state of each. Push for status, not just titles.
3. **Who matters.** The people, clients, teams, or companies that come up
   regularly, and how each relates to them. Names matter here.
4. **Standing rules.** Decisions and preferences you should never re-ask:
   how they want to be spoken to, what is off limits, choices already made.
5. **Where the work lives.** Which folders, tools, and accounts hold the real
   material. This becomes the map for rung two, so note what is not reachable
   yet rather than pretending it is.
6. **What drains the time.** The recurring work they resent doing by hand. Ask
   for the last three times it happened. These are the candidates the `level-up`
   skill will draw from later.
7. **Their voice.** Ask them to paste two or three samples of their real
   writing: a sent email, a message, a published post. Then run
   `holt voice add <file>` if the samples are in files, or tell them the command
   so their drafts sound like them rather than like a model.

### Saving as you go

After every two questions, write what you learned to memory with:

```
holt memory add "<one durable fact>"
```

One fact per call. Several facts can be piped in at once, one per line.

Write facts that will still be true in a month and that a future session could
not guess. "Runs product for a fintech in Bhubaneswar, nine years in" is a fact.
"Wants to be more productive" is noise. Include names, numbers, and dates. Write
the fact so it stands alone, because recall will surface it without this
conversation around it.

If you cannot run commands in this session, write the facts out as a block of
`holt memory add` lines and ask the user to paste them into their terminal.
Do not hand-edit `facts.md`: facts added that way are never embedded, so
semantic recall will not find them.

### Finishing

1. Show what was captured: run `holt memory facts` so they see their own words
   stored in a file they own and can edit.
2. Prove it works. Ask one question whose answer depends on what they just told
   you, and answer it from memory. This is the moment the tool becomes real, so
   do not skip it.
3. Do one real thing now. Pick the smallest useful task from what they said
   drains their time and complete it in this session. An artifact beats a plan.
4. Name rung two. Tell them the single next step, usually `holt hook` so Claude
   Code remembers automatically, or `holt mcp setup` to reach their other tools.
   One step, not a menu.
5. Point at the ritual: `/skill level-up` weekly turns one drain into one
   automation, and `/skill audit` shows which rung they are on.

## Example

Not: "Tell me about your business, your projects, your clients, your
preferences, and your writing style."

Instead: "First one. What is your work, and what does a normal Tuesday actually
look like?" then, after the answer: "Got it. Now the live list: what are the three to five
things genuinely in flight this week?"

Then, quietly, between questions:

```
holt memory add "Senior product manager, nine years, currently between roles and job-hunting in the Netherlands"
holt memory add "Runs Sasyam Agro with an uncle in Bargarh; demo plots are on the uncle's land"
```
