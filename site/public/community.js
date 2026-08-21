(() => {
  'use strict';

  const POLL_ENDPOINT = '/api/community/poll';
  const SUBMISSION_ENDPOINT = '/api/community/submissions';
  const VOTE_ENDPOINT = '/api/community/vote';
  const POLL_REFRESH_MS = 20_000;
  const VOTER_STORAGE_KEY = 'tabmonger.community.voter.v1';
  const VOTE_STORAGE_KEY = 'tabmonger.community.vote.v1';

  const readStorage = (key) => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  };

  const writeStorage = (key, value) => {
    try {
      window.localStorage.setItem(key, value);
      return window.localStorage.getItem(key) === value;
    } catch {
      return false;
    }
  };

  const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  const randomVoterId = () => {
    if (window.crypto?.randomUUID) {
      const id = window.crypto.randomUUID();
      return UUID_V4_PATTERN.test(id) ? id : null;
    }
    if (!window.crypto?.getRandomValues) return null;

    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };

  const getVoterId = () => {
    const existing = readStorage(VOTER_STORAGE_KEY);
    if (existing && UUID_V4_PATTERN.test(existing)) return writeStorage(VOTER_STORAGE_KEY, existing) ? existing : null;
    const created = randomVoterId();
    return created && writeStorage(VOTER_STORAGE_KEY, created) ? created : null;
  };

  const setMessage = (element, message, tone = '') => {
    if (!element) return;
    if (element.textContent !== message) element.textContent = message;
    if (tone) element.dataset.tone = tone;
    else delete element.dataset.tone;
  };

  const form = document.querySelector('[data-community-form]');
  if (form instanceof HTMLFormElement) {
    const feedbackPanel = document.querySelector('[data-feedback-panel]');
    const submitButton = form.querySelector('[data-community-submit]');
    const formStatus = form.querySelector('[data-community-form-status]');
    const titleInput = form.querySelector('#community-title');
    const detailsInput = form.querySelector('#community-details');
    const titleLabel = form.querySelector('[data-community-title-label]');
    const titleHelp = form.querySelector('[data-community-title-help]');
    const detailsLabel = form.querySelector('[data-community-details-label]');

    const updateCount = (field) => {
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
      const output = form.querySelector(`[data-character-count="${field.id}"]`);
      if (output) output.textContent = String(field.value.length);
    };

    const selectedKind = () => {
      const checked = form.querySelector('input[name="kind"]:checked');
      return checked instanceof HTMLInputElement && checked.value === 'feedback' ? 'feedback' : 'feature';
    };

    const updateKindCopy = () => {
      const isGeneral = selectedKind() === 'feedback';
      if (titleLabel) titleLabel.textContent = isGeneral ? 'Feedback subject' : 'Feature title';
      if (titleHelp) {
        titleHelp.textContent = isGeneral
          ? 'A short subject helps route your private feedback.'
          : 'Keep it short and specific. If approved, this title is the only part shown publicly.';
      }
      if (detailsLabel) detailsLabel.textContent = isGeneral ? 'What should we know?' : 'How would this help?';
      if (submitButton) submitButton.textContent = isGeneral ? 'Send private feedback' : 'Send for review';
    };

    form.querySelectorAll('[data-character-count]').forEach((output) => {
      const fieldId = output.getAttribute('data-character-count');
      const field = fieldId ? document.getElementById(fieldId) : null;
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        updateCount(field);
        field.addEventListener('input', () => {
          field.setCustomValidity('');
          updateCount(field);
        });
      }
    });

    form.querySelectorAll('[data-community-kind]').forEach((input) => {
      input.addEventListener('change', updateKindCopy);
    });
    updateKindCopy();

    document.querySelectorAll('[data-suggest-idea]').forEach((button) => {
      button.addEventListener('click', () => {
        if (!(feedbackPanel instanceof HTMLElement)) return;
        feedbackPanel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        const featureKind = form.querySelector('input[name="kind"][value="feature"]');
        if (featureKind instanceof HTMLInputElement) featureKind.checked = true;
        updateKindCopy();
        window.requestAnimationFrame(() => {
          feedbackPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          titleInput?.focus({ preventScroll: true });
        });
      });
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!(titleInput instanceof HTMLInputElement) || !(detailsInput instanceof HTMLTextAreaElement)) return;

      const title = titleInput.value.trim();
      const details = detailsInput.value.trim();
      titleInput.setCustomValidity(title.length >= 3 ? '' : 'Enter at least 3 characters.');
      detailsInput.setCustomValidity(details.length >= 5 ? '' : 'Enter at least 5 characters.');
      if (!form.checkValidity()) {
        form.reportValidity();
        setMessage(formStatus, 'Check the highlighted fields and try again.', 'error');
        return;
      }

      const formData = new FormData(form);
      const kind = selectedKind();
      const payload = {
        kind,
        title,
        details,
        website: String(formData.get('website') || '')
      };

      if (submitButton instanceof HTMLButtonElement) submitButton.disabled = true;
      form.setAttribute('aria-busy', 'true');
      setMessage(formStatus, kind === 'feedback' ? 'Sending private feedback…' : 'Sending for review…');

      try {
        const response = await fetch(SUBMISSION_ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const error = new Error('Submission failed');
          error.status = response.status;
          throw error;
        }

        form.reset();
        titleInput.setCustomValidity('');
        detailsInput.setCustomValidity('');
        updateCount(titleInput);
        updateCount(detailsInput);
        updateKindCopy();
        setMessage(
          formStatus,
          kind === 'feedback'
            ? 'Thank you. Your private feedback was sent.'
            : 'Thank you. Your request is waiting for owner review; only an approved title can join the poll.',
          'success'
        );
      } catch (error) {
        if (error?.status === 429) {
          setMessage(formStatus, 'Please wait a little before sending another message.', 'error');
        } else if (error?.status === 400 || error?.status === 413 || error?.status === 422) {
          setMessage(formStatus, 'That message could not be accepted. Check the fields and try again.', 'error');
        } else {
          setMessage(formStatus, 'Feedback is temporarily unavailable. Your message was not sent; please try again soon.', 'error');
        }
      } finally {
        form.removeAttribute('aria-busy');
        if (submitButton instanceof HTMLButtonElement) submitButton.disabled = false;
      }
    });
  }

  const pollPanel = document.querySelector('[data-community-poll]');
  const pollList = document.querySelector('[data-poll-list]');
  const pollState = document.querySelector('[data-poll-state]');
  const voteStatus = document.querySelector('[data-vote-status]');
  const pollUpdated = document.querySelector('[data-poll-updated]');
  const refreshButton = document.querySelector('[data-poll-refresh]');

  if (!(pollPanel instanceof HTMLElement) || !(pollList instanceof HTMLOListElement)) return;

  const voterId = getVoterId();
  const storedFeatureId = readStorage(VOTE_STORAGE_KEY);
  let selectedFeatureId = storedFeatureId && UUID_V4_PATTERN.test(storedFeatureId) ? storedFeatureId : null;
  let currentItems = [];
  let currentRenderSignature = '';
  let pollRequestInFlight = false;
  let voteInFlight = false;
  let hasPollResponse = false;

  const normalizeItems = (payload) => {
    if (!payload || !Array.isArray(payload.items)) throw new Error('Invalid poll response');
    const seen = new Set();
    return payload.items.flatMap((item) => {
      if (!item || typeof item.id !== 'string' || !UUID_V4_PATTERN.test(item.id) || typeof item.title !== 'string') return [];
      const key = String(item.id);
      const title = item.title.trim();
      const numericVotes = Number(item.votes);
      if (!key || key.length > 128 || !title || title.length > 80 || seen.has(key) || !Number.isFinite(numericVotes)) return [];
      seen.add(key);
      return [{
        id: item.id,
        key,
        title,
        votes: Math.max(0, Math.floor(numericVotes))
      }];
    });
  };

  const updatePollTimestamp = (value) => {
    if (!(pollUpdated instanceof HTMLTimeElement)) return;
    const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      pollUpdated.hidden = true;
      pollUpdated.removeAttribute('datetime');
      pollUpdated.textContent = '';
      return;
    }
    pollUpdated.dateTime = date.toISOString();
    pollUpdated.textContent = `Updated ${new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }).format(date)}`;
    pollUpdated.hidden = false;
  };

  const setPollButtonsDisabled = (disabled) => {
    pollList.querySelectorAll('button').forEach((button) => {
      if (button instanceof HTMLButtonElement) button.disabled = disabled || !voterId;
    });
  };

  const updateVoteGuidance = (items) => {
    const totalVotes = items.reduce((total, item) => total + item.votes, 0);
    const totalLabel = `${totalVotes.toLocaleString()} total ${totalVotes === 1 ? 'vote' : 'votes'}`;
    if (!voterId) {
      setMessage(voteStatus, 'Voting needs local storage and secure random-number support. You can still read the poll and send feedback.', 'error');
    } else if (!voteInFlight && selectedFeatureId && items.some((item) => item.key === selectedFeatureId)) {
      setMessage(voteStatus, `${totalLabel}. Your choice is marked; choose another idea anytime to change it.`);
    } else if (!voteInFlight) {
      setMessage(voteStatus, 'Choose one idea to see the live results. One current vote is kept per locally stored browser ID.');
    }
  };

  const renderPoll = (items) => {
    currentItems = items;
    const renderSignature = JSON.stringify({
      selectedFeatureId,
      items: items.map(({ key, title, votes }) => [key, title, votes])
    });
    if (renderSignature === currentRenderSignature) {
      if (items.length === 0) {
        pollList.hidden = true;
        if (pollState instanceof HTMLElement) pollState.hidden = false;
        setMessage(pollState, 'No approved feature ideas are up for a vote yet. Suggest one and check back soon.');
      } else {
        if (pollState instanceof HTMLElement) pollState.hidden = true;
        updateVoteGuidance(items);
      }
      return;
    }

    const focused = document.activeElement;
    const focusedFeatureId = focused instanceof HTMLButtonElement && focused.classList.contains('poll-choice')
      ? focused.dataset.featureId
      : null;
    pollList.replaceChildren();
    currentRenderSignature = renderSignature;

    if (items.length === 0) {
      pollList.hidden = true;
      if (pollState instanceof HTMLElement) pollState.hidden = false;
      setMessage(pollState, 'No approved feature ideas are up for a vote yet. Suggest one and check back soon.');
      return;
    }

    const showResults = Boolean(selectedFeatureId && items.some((item) => item.key === selectedFeatureId));
    const totalVotes = items.reduce((total, item) => total + item.votes, 0);
    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      const listItem = document.createElement('li');
      const button = document.createElement('button');
      const marker = document.createElement('span');
      const title = document.createElement('span');
      const result = document.createElement('span');
      const percentageLabel = document.createElement('strong');
      const voteCount = document.createElement('small');
      const meter = document.createElement('span');
      const meterFill = document.createElement('span');
      const isSelected = selectedFeatureId === item.key;
      const percentage = totalVotes > 0 ? Math.round((item.votes / totalVotes) * 100) : 0;

      listItem.className = 'poll-item';
      button.className = 'poll-choice';
      if (showResults) button.classList.add('poll-choice-results');
      button.type = 'button';
      button.dataset.featureId = item.key;
      button.disabled = voteInFlight || !voterId;
      button.setAttribute('aria-pressed', String(isSelected));
      button.setAttribute(
        'aria-label',
        showResults
          ? `${item.title}, ${percentage} percent, ${item.votes.toLocaleString()} ${item.votes === 1 ? 'vote' : 'votes'}${isSelected ? ', your current vote' : ''}`
          : item.title
      );
      marker.className = 'poll-marker';
      marker.setAttribute('aria-hidden', 'true');
      title.className = 'poll-item-title';
      title.textContent = item.title;
      if (isSelected) {
        const selectedLabel = document.createElement('small');
        selectedLabel.className = 'poll-selected-label';
        selectedLabel.textContent = 'Your vote';
        title.append(selectedLabel);
      }
      result.className = 'poll-vote-result';
      result.hidden = !showResults;
      percentageLabel.textContent = `${percentage}%`;
      voteCount.textContent = `${item.votes.toLocaleString()} ${item.votes === 1 ? 'vote' : 'votes'}`;
      result.append(percentageLabel, voteCount);
      meter.className = 'poll-meter';
      meter.hidden = !showResults;
      meter.setAttribute('aria-hidden', 'true');
      meterFill.className = 'poll-meter-fill';
      meterFill.style.width = `${percentage}%`;
      meter.append(meterFill);
      button.append(marker, title, result, meter);
      button.addEventListener('click', () => submitVote(item));
      listItem.append(button);
      fragment.append(listItem);
    });

    pollList.append(fragment);
    if (focusedFeatureId) {
      const nextFocused = Array.from(pollList.querySelectorAll('.poll-choice'))
        .find((button) => button instanceof HTMLButtonElement && button.dataset.featureId === focusedFeatureId);
      if (nextFocused instanceof HTMLButtonElement) nextFocused.focus({ preventScroll: true });
    }
    pollList.hidden = false;
    if (pollState instanceof HTMLElement) pollState.hidden = true;
    updateVoteGuidance(items);
  };

  const loadPoll = async ({ manual = false } = {}) => {
    if (pollRequestInFlight) return;
    pollRequestInFlight = true;
    pollPanel.setAttribute('aria-busy', 'true');
    if (refreshButton instanceof HTMLButtonElement) refreshButton.disabled = true;

    if (!hasPollResponse && pollState instanceof HTMLElement) {
      pollState.hidden = false;
      setMessage(pollState, 'Loading approved feature ideas…');
    } else if (manual) {
      setMessage(voteStatus, 'Refreshing the poll…');
    }

    try {
      const response = await fetch(POLL_ENDPOINT, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      if (!response.ok) {
        const error = new Error('Poll request failed');
        error.status = response.status;
        throw error;
      }
      const payload = await response.json();
      const items = normalizeItems(payload);
      hasPollResponse = true;
      renderPoll(items);
      updatePollTimestamp(payload.updatedAt);
    } catch (error) {
      const rateLimited = error?.status === 429;
      if (!hasPollResponse || currentItems.length === 0) {
        pollList.hidden = true;
        if (pollState instanceof HTMLElement) pollState.hidden = false;
        setMessage(
          pollState,
          rateLimited
            ? 'The poll is refreshing too quickly. Please wait a moment and try again.'
            : 'The live poll is temporarily unavailable. You can still try sending feedback or refresh again soon.',
          'error'
        );
      } else {
        setMessage(voteStatus, 'Live refresh is temporarily unavailable. Showing the last poll update.', 'error');
      }
    } finally {
      pollRequestInFlight = false;
      pollPanel.removeAttribute('aria-busy');
      if (refreshButton instanceof HTMLButtonElement) refreshButton.disabled = false;
    }
  };

  async function submitVote(item) {
    if (voteInFlight || !item) return;
    if (!voterId) {
      setMessage(voteStatus, 'Voting is unavailable because this browser could not save a secure anonymous voting ID.', 'error');
      return;
    }
    if (selectedFeatureId === item.key) {
      setMessage(voteStatus, 'That is already your current vote. Choose a different title to change it.');
      return;
    }

    voteInFlight = true;
    pollPanel.setAttribute('aria-busy', 'true');
    setPollButtonsDisabled(true);
    setMessage(voteStatus, selectedFeatureId ? 'Changing your vote…' : 'Saving your vote…');

    try {
      const response = await fetch(VOTE_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ featureId: item.id, voterId })
      });
      if (!response.ok) {
        const error = new Error('Vote failed');
        error.status = response.status;
        throw error;
      }

      const previousFeatureId = selectedFeatureId;
      selectedFeatureId = item.key;
      currentItems = currentItems.map((currentItem) => ({
        ...currentItem,
        votes: Math.max(0, currentItem.votes
          + (currentItem.key === selectedFeatureId ? 1 : 0)
          - (currentItem.key === previousFeatureId ? 1 : 0))
      }));
      const rememberedChoice = writeStorage(VOTE_STORAGE_KEY, selectedFeatureId);
      renderPoll(currentItems);
      setMessage(
        voteStatus,
        rememberedChoice
          ? 'Vote saved. Choose another title anytime to change it.'
          : 'Vote saved, but this browser could not remember which title you chose. Your anonymous voting ID remains unchanged.',
        rememberedChoice ? 'success' : 'error'
      );
      await loadPoll();
    } catch (error) {
      if (error?.status === 429) {
        setMessage(voteStatus, 'Please wait a moment before changing your vote again.', 'error');
      } else if (error?.status === 400 || error?.status === 404 || error?.status === 409 || error?.status === 422) {
        setMessage(voteStatus, 'That idea is no longer available for voting. Refresh the poll and try again.', 'error');
      } else {
        setMessage(voteStatus, 'Voting is temporarily unavailable. Your vote was not changed; please try again.', 'error');
      }
    } finally {
      voteInFlight = false;
      pollPanel.removeAttribute('aria-busy');
      setPollButtonsDisabled(false);
    }
  }

  if (refreshButton instanceof HTMLButtonElement) {
    refreshButton.addEventListener('click', () => loadPoll({ manual: true }));
  }

  loadPoll();
  window.setInterval(() => {
    if (document.visibilityState === 'visible') loadPoll();
  }, POLL_REFRESH_MS);
})();
