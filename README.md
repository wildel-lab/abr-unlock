# ABR Unlock 3.0

A free spaced-repetition gate for iPhone. Opening a gated app sends you (via Shortcuts) to this
page; you answer a short batch of due cards scheduled with FSRS; the ABR Pass shortcut records
the pass, appends the batch to `reviews-log.txt`, and lets you in for 15 minutes.

Everything (cards, images, history) is stored on the phone in Safari. Nothing is uploaded.

## How cards are shown

- **Flashcards (default):** your question exactly as written; recall the answer during the
  think time, reveal, rate Again / Hard / Good / Easy.
- **Multiple choice:** only for cards that come with their own answer choices (CSV `options`).
- **Calculations:** type a number (units optional and converted, e.g. 0.002 Gy = 2 mGy), or
  tap "show the solution" (counts as a miss). Tolerance per card; 0 means exact.
- **Generated choices (experimental, off):** per deck, builds options from your other cards.
  More than one option may be defensible, so it's labelled and not the default.

## Getting Quizlet sets in, with images

In Anki on your PC: **File → Export → Anki Deck Package (.apkg)**, tick **Include media** and
**Support older Anki versions** (and **Include scheduling information** to bring your Anki
history). Put the file on the phone and choose it under *Import cards*. Each card is rendered
with its own Anki template: images on either side, reversed cards and each cloze number.
Anki styling and scripts aren't carried over. Image Occlusion cards are listed and left out.

Also accepted: Quizlet .txt, Anki "Notes in Plain Text", CSV
(`id,deck,topic,type,question,answer,options,tolerance,explanation,source,image,answer image`).

## Study modes

- **General:** all decks; the deck studied longest ago first, decks mixed in each batch,
  most-forgotten card first within a deck.
- **Focus:** only ticked decks, on the same FSRS schedule. Each deck also has a Study button.

## Backups

- Every finished batch goes to `iCloud Drive › Shortcuts › reviews-log.txt` via ABR Pass.
- ABR Gate hands `abr-pass.txt` back in `&ack=`; only then is a review marked saved.
  Unconfirmed reviews are never discarded; they are re-sent until confirmed.
- Changes to target recall / longest interval are logged too, so a replay uses the settings
  that were in force at the time.
- *Export full backup (.zip)*: cards, images, settings, settings history, full review history.

Rebuild on a new phone: import the same deck files, then *Restore progress from
reviews-log.txt*, or import the full backup .zip.

## Credits

FSRS-5 model and default parameters: open-spaced-repetition (MIT). KaTeX (MIT). JSZip (MIT/GPLv3).
