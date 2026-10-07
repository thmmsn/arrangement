// Vinduet med personvern og databehandleravtaler (LEGAL_FILE, se legalDialog i src/theme.js).
//
// Nyere nettlesere klarer seg uten dette skriptet: knappene har commandfor/command, som åpner og lukker
// <dialog> av seg selv, og closedby="any" lukker vinduet ved et klikk utenfor. Her gjøres det samme for
// nettlesere som mangler en av delene. Esc lukker et <dialog> i alle nettlesere som kan vise det.

const dialog = document.getElementById('legal-dialog');

if (dialog) {
  // Svært gamle nettlesere uten <dialog>: vinduet vises med open-attributtet (stilen i style.css
  // legger det over siden likevel), og Esc lukker det.
  const canShowModal = typeof dialog.showModal === 'function';
  // hasAttribute og ikke dialog.open: egenskapen finnes bare i nettlesere som kan <dialog>.
  const isOpen = () => dialog.hasAttribute('open');
  const open = () => {
    if (isOpen()) return;
    if (canShowModal) dialog.showModal();
    else dialog.setAttribute('open', '');
  };
  const close = () => {
    if (canShowModal) dialog.close();
    else dialog.removeAttribute('open');
  };

  if (!('command' in HTMLButtonElement.prototype)) {
    for (const button of document.querySelectorAll('button[commandfor="legal-dialog"]')) {
      button.addEventListener('click', () => (button.getAttribute('command') === 'show-modal' ? open() : close()));
    }
    if (!canShowModal) document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) close(); });
  }

  if (!('closedBy' in dialog)) {
    // Bare et klikk som både starter og slutter utenfor vinduet, lukker det. Ellers ville det lukket seg
    // når man merker tekst i vinduet og slipper museknappen utenfor (klikket havner da på <dialog>).
    const outside = (e) => {
      const box = dialog.getBoundingClientRect();
      return e.target === dialog
        && (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom);
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
    dialog.addEventListener('click', (e) => {
      if (pressedOutside && outside(e)) close();
      pressedOutside = false;
    });
  }
}
