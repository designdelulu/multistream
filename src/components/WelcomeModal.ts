const STORAGE_KEY = 'multistream:welcome-dismissed';

function isWelcomeDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function markWelcomeDismissed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Ignore storage failures; modal can still close for this session.
  }
}

function openWelcome(): void {
  document.documentElement.classList.add('show-welcome');
  document.getElementById('welcome-enter')?.focus();
}

function closeWelcome(): void {
  document.documentElement.classList.remove('show-welcome');
  markWelcomeDismissed();
}

export function bindWelcomeModal(): void {
  const modal = document.querySelector<HTMLElement>('#welcome-modal');
  const enterButton = document.querySelector<HTMLButtonElement>('#welcome-enter');

  if (!modal || !enterButton) {
    return;
  }

  if (isWelcomeDismissed()) {
    document.documentElement.classList.remove('show-welcome');
  } else {
    openWelcome();
  }

  enterButton.addEventListener('click', closeWelcome);

  modal.addEventListener('click', (event) => {
    if (event.target === modal.querySelector('.welcome-modal__backdrop')) {
      closeWelcome();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.documentElement.classList.contains('show-welcome')) {
      closeWelcome();
    }
  });
}
