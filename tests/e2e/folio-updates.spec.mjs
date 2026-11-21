import assert from 'node:assert/strict'
import { openChat } from './chat-view.spec.mjs'
import { callMcp, until } from './harness.mjs'

/* Folio's play mode and its updates (PRDCT-4832), on the real app with the
   echo adapter (the agent answers with the reader's own words) and the
   system voice stubbed in the page (each utterance recorded, spoken for a
   moment, one after the other). Three Folio tabs: two in a group named
   Atlas, one ungrouped named Harbor; the play mode on. What it holds:
   1. a message written to the tab that is NOT selected ends in the spoken
      line "I have an update for you on Atlas.", the chip waiting and naming
      the group, the card opened as a banner, the selected tab's composer
      still holding the focus;
   2. the key (a real keydown of Ctrl+Shift+Space in the window) reads that
      answer without selecting its tab: the chip goes preparing then
      playing, the voice is given the answer's words;
   3. selecting the tab shows the same reading on its page: the voice card
      playing, a block lit;
   4. a second update arriving during a reading is not announced until the
      reading ends, then is;
   6. the ungrouped tab is announced by its own name (with 4);
   7. Dismiss removes a row; going to a tab removes its update; a newer
      answer replaces the older update of the same tab (and is announced
      afresh);
   5. with Settings open over the tabs, the same announcement and the same
      key;
   8. `__claveE2E.updatesKey.registered()` lists the accelerator only while
      an update waits or plays, and `press()` plays; with the preference off
      the list stays empty and the in-app key still works;
   9. with the play mode off, an answer finished off the page files nothing
      and says nothing;
   and the lane review's: the update key with nothing waiting is left to the
   composer (never default-prevented), taken while an update waits; Open
   from the card, over Settings, lands on the reading's page. That a tab's
   past arriving is never a turn is pinned in `lab/use-conversation.test.ts`:
   the harness cannot mount a Folio pane again over a finished conversation
   (a reload drops the echo tabs).
   The key is never registered with the OS under the harness
   (`--test-no-activate`); every name and every answer here is invented. */

const FOLIO = ['--dev-echo-view=clave.chat-view/lab']
const READY = '[data-testid="folio-view"] textarea:not(:disabled)'
const UTTERANCE_MS = 1200
const ACCELERATOR = 'Control+Shift+Space'

const answer = (word, blocks = 2) =>
  Array.from({ length: blocks }, (_, i) => `${word} block ${i + 1} of the answer.`).join('\n\n')

/** The system voice in the page: every utterance is recorded with when it
 *  started, spoken for UTTERANCE_MS, one after another; cancel drops what is
 *  queued. The chip's states are recorded as it takes them. */
async function stubVoice(win) {
  await win.evaluate((ms) => {
    window.__spoken = []
    window.__chip = []
    new MutationObserver(() => {
      const chip = document.querySelector('[data-testid="update-chip"]')
      const state = chip?.getAttribute('data-state') ?? 'none'
      if (window.__chip.at(-1) !== state) window.__chip.push(state)
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state']
    })
    const stub = {
      speaking: false,
      pending: false,
      paused: false,
      speak(utterance) {
        window.__spoken.push(utterance.text)
        const at = window.__spoken.length
        const startAt = (window.__voiceFree ?? 0) > Date.now() ? window.__voiceFree : Date.now()
        window.__voiceFree = startAt + ms
        setTimeout(
          () => {
            if (window.__cancelledBefore >= at) return
            utterance.onstart?.()
            setTimeout(() => {
              if (window.__cancelledBefore >= at) return
              utterance.onend?.()
            }, ms - 20)
          },
          startAt - Date.now() + 10
        )
      },
      cancel() {
        window.__cancelledBefore = window.__spoken.length
        window.__voiceFree = 0
      },
      pause: () => undefined,
      resume: () => undefined,
      getVoices: () => [],
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }
    Object.defineProperty(window, 'speechSynthesis', { value: stub, configurable: true })
  }, UTTERANCE_MS)
}

const spoken = (win) => win.evaluate(() => window.__spoken.slice())
const said = (win, line) => win.evaluate((l) => window.__spoken.filter((s) => s === l).length, line)
const atlasLine = 'I have an update for you on Atlas.'
const harborLine = 'I have an update for you on Harbor.'

export async function run(t) {
  const chat = await openChat('folio-updates', FOLIO, READY, {}, null, { server: 'in-process' })
  const { app, win, record } = chat
  const pane = (id) => win.locator(`[data-session-id="${id}"] [data-testid="folio-view"]`)
  const chip = win.locator('[data-testid="update-chip"]')
  const card = win.locator('[data-testid="update-card"]')
  const rows = win.locator('[data-testid="update-row"]')
  const write = (id, text) =>
    win.evaluate(
      ([sid, body]) => window.electronAPI.sessionsWrite(sid, { type: 'user_message', text: body }),
      [id, text]
    )
  const focus = async (id) => {
    await callMcp(app, 'focus', { sessionId: id })
    await pane(id).locator('textarea[aria-label="Message"]').waitFor({ state: 'visible' })
  }
  const waitSaid = (line, count = 1, tries = 200) =>
    until(async () => ((await said(win, line)) >= count ? true : null), { tries, gapMs: 50 })
  const chipState = async () => ((await chip.count()) ? chip.getAttribute('data-state') : 'none')
  const waitChip = (state, tries = 200) =>
    until(async () => ((await chipState()) === state ? true : null), { tries, gapMs: 50 })
  const registered = () => app.evaluate(() => globalThis.__claveE2E.updatesKey.registered())
  const openCard = async () => {
    if ((await card.count()) && (await card.getAttribute('data-open')) === 'pinned') return
    await chip.locator('.update-chip-text').click()
    await until(async () => ((await card.getAttribute('data-open')) === 'pinned' ? true : null))
  }

  try {
    // ── Three Folio tabs: A and B in Atlas, C alone as Harbor ──
    const A = record.id
    const ids = [A]
    for (let i = 0; i < 2; i++) {
      await win.locator('.launcher-split .launcher-btn').click()
      const next = await until(async () =>
        (await win.evaluate(() => window.electronAPI.sessionsList())).find(
          (s) => s.adapterId === 'echo' && !ids.includes(s.id)
        )
      )
      assert.ok(next, 'a new echo tab opened')
      ids.push(next.id)
      await pane(next.id).locator('textarea:not(:disabled)').waitFor()
    }
    const [, B, C] = ids
    const { groupId } = await callMcp(app, 'createGroup', { name: 'Atlas' })
    for (const id of [A, B]) await callMcp(app, 'moveSession', { sessionId: id, groupId })
    await callMcp(app, 'rename', { target: 'session', id: C, name: 'Harbor' })
    await stubVoice(win)

    // The play mode on, from the selected tab's speaker switch: one switch
    // for every pane.
    await focus(A)
    const toggle = pane(A).locator('.folio-voice-toggle')
    await toggle.click()
    t.equal('the speaker switch is on', await toggle.getAttribute('aria-pressed'), 'true')
    t.equal(
      'and on in every Folio pane at once',
      await pane(B).locator('.folio-voice-toggle').getAttribute('aria-pressed'),
      'true'
    )
    t.equal('no update, no chip', await chip.count(), 0)
    t.check('the key is held by nobody yet', (await registered()).length === 0, await registered())
    // With nothing to do, the chord reaches the field: never default-prevented.
    await win.evaluate(() => {
      window.__keyPrevented = []
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.code === 'Space' && event.ctrlKey && event.shiftKey)
            window.__keyPrevented.push(event.defaultPrevented)
        },
        true
      )
    })
    await pane(A).locator('textarea[aria-label="Message"]').click()
    await win.keyboard.press('Control+Shift+Space')
    t.equal(
      'with nothing waiting, the update key in the composer is left to the composer',
      JSON.stringify(await win.evaluate(() => window.__keyPrevented)),
      '[false]'
    )

    // ── 1. An answer finished off the page is announced ──
    const composerA = pane(A).locator('textarea[aria-label="Message"]')
    await composerA.click()
    await write(B, answer('Bravo', 4))
    t.check(
      'a message written to the tab not selected ends in the spoken line naming its group',
      !!(await waitSaid(atlasLine)),
      await spoken(win)
    )
    t.equal('the chip waits', await chipState(), 'waiting')
    t.equal(
      'and names the group',
      (await chip.locator('.update-chip-name').innerText()).trim(),
      'Update on Atlas'
    )
    t.equal('the card opened as a banner', await card.getAttribute('data-open'), 'banner')
    t.check(
      "the selected tab's composer still holds the focus",
      await win.evaluate(
        (id) =>
          document.activeElement?.tagName === 'TEXTAREA' &&
          !!document.activeElement.closest(`[data-session-id="${id}"]`),
        A
      )
    )
    t.check(
      'the answer was not read: only the line was said',
      !(await spoken(win)).some((s) => s.includes('Bravo')),
      await spoken(win)
    )
    t.equal('one waiting row, for the tab', await rows.getAttribute('data-session-id'), B)
    t.equal(
      'while an update waits, the key is held under its accelerator',
      JSON.stringify(await registered()),
      JSON.stringify([ACCELERATOR])
    )

    // ── 2. The key reads it, without selecting the tab ──
    await win.evaluate(() => (window.__chip = []))
    await win.keyboard.press('Control+Shift+Space')
    t.equal(
      'with an update waiting, the key is taken',
      JSON.stringify(await win.evaluate(() => window.__keyPrevented)),
      '[false,true]'
    )
    t.check(
      'the chip goes playing',
      !!(await waitChip('playing')),
      await win.evaluate(() => window.__chip)
    )
    const chipSeq = await win.evaluate(() => window.__chip)
    t.check(
      'after preparing',
      chipSeq.indexOf('preparing') >= 0 &&
        chipSeq.indexOf('preparing') < chipSeq.indexOf('playing'),
      chipSeq
    )
    t.check(
      "the voice was given the answer's words",
      !!(await until(
        async () => ((await spoken(win)).some((s) => s.includes('Bravo block 1')) ? true : null),
        { tries: 100, gapMs: 50 }
      )),
      await spoken(win)
    )
    t.check('the selected tab is unchanged', await composerA.isVisible())
    t.check('and the read tab is not shown', !(await pane(B).isVisible()))
    t.equal(
      'while a reading plays, the key is still held',
      JSON.stringify(await registered()),
      JSON.stringify([ACCELERATOR])
    )

    // ── 3. Going to the tab shows the same reading on its page ──
    const cancelsBefore = await win.evaluate(() => window.__cancelledBefore ?? 0)
    await focus(B)
    const voiceCard = pane(B).locator('[data-testid="folio-voice-card"]')
    t.check(
      'the voice card plays on the page',
      !!(await until(async () =>
        (await voiceCard.getAttribute('data-voice-state')) === 'playing' ? true : null
      )),
      await voiceCard.getAttribute('data-voice-state')
    )
    t.check(
      'a block is lit',
      !!(await until(async () =>
        (await pane(B).locator('.folio-block[data-reading="true"]').count()) === 1 ? true : null
      ))
    )
    t.equal(
      'going there stopped nothing',
      await win.evaluate(() => window.__cancelledBefore ?? 0),
      cancelsBefore
    )
    t.equal('with its page on screen and nothing waiting, the chip goes', await chipState(), 'none')

    // ── 4 and 6. An update during a reading waits for its end; the ungrouped tab by its name ──
    await focus(A)
    t.check(
      'the reading goes on off the page: the chip plays',
      !!(await waitChip('playing')),
      await chipState()
    )
    await write(C, answer('Charlie'))
    await openCard()
    t.check(
      'the second update is filed while the reading plays',
      !!(await until(async () =>
        (await win.locator(`[data-testid="update-row"][data-session-id="${C}"]`).count()) === 1
          ? true
          : null
      ))
    )
    await new Promise((resolve) => setTimeout(resolve, UTTERANCE_MS))
    t.equal('and is not announced while the reading plays', await said(win, harborLine), 0)
    t.equal('the reading still plays', await chipState(), 'playing')
    t.check(
      'once the reading ends, it is announced, by the tab’s own name',
      !!(await waitSaid(harborLine, 1, 400)),
      await spoken(win)
    )
    const order = await spoken(win)
    t.check(
      'after the last block of the reading',
      order.indexOf(harborLine) > order.findLastIndex((s) => s.includes('Bravo block 4')),
      order
    )

    // ── 7. Dismiss, going to the tab, a newer answer ──
    await openCard()
    await win
      .locator(
        `[data-testid="update-row"][data-session-id="${C}"] [data-testid="update-row-dismiss"]`
      )
      .click()
    t.check(
      'Dismiss removes the row',
      !!(await until(async () => ((await rows.count()) === 0 ? true : null))),
      await rows.count()
    )
    t.equal('nothing waits: the chip goes', await chipState(), 'none')

    await write(B, answer('Delta'))
    assert.ok(await waitSaid(atlasLine, 2), 'the next update of B is announced')
    await focus(B)
    t.check(
      'going to its tab removes its update',
      !!(await until(async () => ((await chipState()) === 'none' ? true : null))),
      await chipState()
    )
    await focus(A)
    await write(B, answer('Echo'))
    assert.ok(await waitSaid(atlasLine, 3), 'an update of B again')
    await write(B, answer('Foxtrot'))
    t.check(
      'a newer answer of the same tab is announced afresh',
      !!(await waitSaid(atlasLine, 4)),
      await spoken(win)
    )
    await openCard()
    t.equal('and replaces the older update: one row', await rows.count(), 1)
    t.check('the newest one', (await rows.innerText()).includes('Foxtrot'), await rows.innerText())
    await rows.locator('[data-testid="update-row-dismiss"]').click()
    await until(async () => ((await chipState()) === 'none' ? true : null))
    t.check(
      'with nothing waiting or playing, the key is let go',
      !!(await until(async () => ((await registered()).length === 0 ? true : null))),
      await registered()
    )

    // ── 5. Settings over the tabs: the same announcement, the same key ──
    await win.keyboard.press('Meta+,')
    await win.locator('.settings-page-header').first().waitFor()
    await write(A, answer('Golf', 6))
    t.check(
      'with Settings open, the selected tab’s answer is announced',
      !!(await waitSaid(atlasLine, 5)),
      await spoken(win)
    )
    t.equal('the chip waits', await chipState(), 'waiting')
    await win.keyboard.press('Control+Shift+Space')
    t.check('and the key plays it', !!(await waitChip('playing')), await chipState())
    t.check(
      'the answer is read',
      !!(await until(
        async () => ((await spoken(win)).some((s) => s.includes('Golf block 1')) ? true : null),
        { tries: 100, gapMs: 50 }
      ))
    )
    t.check('Settings stays open', await win.locator('.settings-page-header').first().isVisible())
    // The key again pauses it.
    await win.keyboard.press('Control+Shift+Space')
    t.check('the key pauses the reading', !!(await waitChip('paused')), await chipState())
    // Open from the card lands on the reading's page, over Settings.
    await openCard()
    await win.locator('[data-testid="update-card-open"]').click()
    const cardA = pane(A).locator('[data-testid="folio-voice-card"]')
    t.check(
      "Open from the card lands on the tab's page, the reading on it",
      !!(await until(async () =>
        (await pane(A).isVisible()) &&
        ['playing', 'paused'].includes(await cardA.getAttribute('data-voice-state'))
          ? true
          : null
      )),
      await cardA.getAttribute('data-voice-state')
    )
    t.check(
      'and Settings closed',
      !(await win.locator('.settings-page-header').first().isVisible())
    )
    await cardA.locator('[data-testid="folio-stop"]').click()
    t.check(
      'Stop ends it',
      !!(await until(async () =>
        (await cardA.getAttribute('data-voice-state')) === 'idle' ? true : null
      )),
      await cardA.getAttribute('data-voice-state')
    )
    t.equal('nothing waits or plays: no chip', await chipState(), 'none')

    // ── 8. The system-wide key, its routing and its preference ──
    t.equal('nothing waits: nothing held', (await registered()).length, 0)
    await write(B, answer('Hotel'))
    assert.ok(await waitSaid(atlasLine, 6), 'an update of B')
    t.equal(
      'an update waits: the accelerator is held',
      JSON.stringify(await registered()),
      JSON.stringify([ACCELERATOR])
    )
    const pressed = await app.evaluate(() => globalThis.__claveE2E.updatesKey.press())
    t.check('press() routes the key to this window', pressed === true)
    t.check('and plays the update', !!(await waitChip('playing')), await chipState())
    await openCard()
    await win.locator('[data-testid="update-card-stop"]').click()
    await until(async () => ((await chipState()) === 'none' ? true : null))
    t.check(
      'stopped, nothing waiting: let go',
      !!(await until(async () => ((await registered()).length === 0 ? true : null))),
      await registered()
    )

    await win.evaluate(() => window.electronAPI.updatesKeyEverywhere.set(false))
    t.equal(
      'the preference reads off',
      await win.evaluate(() => window.electronAPI.updatesKeyEverywhere.get()),
      false
    )
    await write(B, answer('India'))
    assert.ok(await waitSaid(atlasLine, 7), 'an update of B')
    t.equal('with the preference off, nothing is held', (await registered()).length, 0)
    await win.keyboard.press('Control+Shift+Space')
    t.check('and the in-app key still plays', !!(await waitChip('playing')), await chipState())
    await openCard()
    await win.locator('[data-testid="update-card-stop"]').click()
    await until(async () => ((await chipState()) === 'none' ? true : null))
    await win.evaluate(() => window.electronAPI.updatesKeyEverywhere.set(true))

    // ── 9. The play mode off: nothing filed, nothing said ──
    await toggle.click()
    t.equal('the switch is off', await toggle.getAttribute('aria-pressed'), 'false')
    const before = (await spoken(win)).length
    await write(B, answer('Juliet'))
    await focus(B)
    await pane(B)
      .locator('.folio-block', { hasText: 'Juliet block 1' })
      .first()
      .waitFor({ timeout: 15_000 })
    await focus(A)
    await new Promise((resolve) => setTimeout(resolve, UTTERANCE_MS))
    await write(C, answer('Kilo'))
    await new Promise((resolve) => setTimeout(resolve, 4_000))
    t.equal('nothing was said', (await spoken(win)).length, before)
    t.equal('nothing was filed: no chip', await chipState(), 'none')
  } finally {
    await chat.close()
  }
}
