import { Component } from '@theme/component';
import { morph } from '@theme/morph';
import { DialogComponent, DialogCloseEvent } from '@theme/dialog';
import { mediaQueryLarge, isMobileBreakpoint, getIOSVersion } from '@theme/utilities';
import VariantPicker from '@theme/variant-picker';
import { StandardEvents, ProductSelectEvent, CartLinesUpdateEvent } from '@shopify/events';

export class QuickAddComponent extends Component {
  /** @type {AbortController | null} */
  #abortController = null;
  /** @type {Map<string, Element>} */
  #cachedContent = new Map();
  /** @type {AbortController} */
  #cartUpdateAbortController = new AbortController();

  get productPageUrl() {
    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));
    if (productCard) return productCard.productPageUrl;

    const hotspotProduct = /** @type {import('./product-hotspot').ProductHotspotComponent | null} */ (
      this.closest('product-hotspot-component')
    );
    const productLink = hotspotProduct?.getHotspotProductLink();

    return productLink?.href || '';
  }

  /**
   * Gets the currently selected variant ID from the product card
   * @returns {string | null} The variant ID or null
   */
  #getSelectedVariantId() {
    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));
    return productCard?.getSelectedVariantId() ?? null;
  }

  connectedCallback() {
    super.connectedCallback();

    mediaQueryLarge.addEventListener('change', this.#closeQuickAddModal);
    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartUpdate, {
      signal: this.#cartUpdateAbortController.signal,
    });
    document.addEventListener(StandardEvents.productSelect, this.#handleProductSelectUpdate);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    mediaQueryLarge.removeEventListener('change', this.#closeQuickAddModal);
    this.#abortController?.abort();
    this.#cartUpdateAbortController.abort();
    document.removeEventListener(StandardEvents.productSelect, this.#handleProductSelectUpdate);
  }

  /**
   * Updates quick-add button state when product variant is selected
   * @param {ProductSelectEvent} event - The product select event
   */
  #handleProductSelectUpdate = (event) => {
    if (!(event.target instanceof HTMLElement)) return;
    if (event.target.closest('product-card') !== this.closest('product-card')) return;
    if (this.dataset.usesSellingPlans === 'true') return;

    // Only flip choose <-> add when both buttons were rendered.
    // Otherwise the flip would hide the sole rendered button and reveal nothing.
    if (this.dataset.rendersBothButtons !== 'true') return;

    const productOptionsCount = this.dataset.productOptionsCount;
    let quickAddButton = productOptionsCount === '1' ? 'add' : 'choose';

    // A single-option card can resolve to an unavailable variant (e.g. re-selecting a
    // sold-out swatch). Keep "Choose" so shoppers reach the picker, not a dead-end disabled "Add".
    if (quickAddButton === 'add' && this.#isSelectedVariantUnavailable()) {
      quickAddButton = 'choose';
    }

    this.setAttribute('data-quick-add-button', quickAddButton);
  };

  /**
   * Whether the card's currently selected swatch maps to an unavailable variant.
   * Reads `data-option-available` off the variant picker's selected option - the same
   * signal the product card uses. Only reports true on an explicit `false`, so an
   * unknown/absent signal leaves the caller's default ("add") untouched.
   * @returns {boolean}
   */
  #isSelectedVariantUnavailable() {
    const productCard = /** @type {import('./product-card').ProductCard | null} */ (this.closest('product-card'));
    return productCard?.variantPicker?.selectedOption?.dataset.optionAvailable === 'false';
  }

  /**
   * Clears the cached content when cart is updated
   */
  #handleCartUpdate = () => {
    this.#cachedContent.clear();
  };

  /**
   * Re-renders the variant picker in the quick-add modal.
   * @param {Element} newHtml - The element to re-render.
   */
  #updateVariantPicker(newHtml) {
    const modalContent = document.getElementById('quick-add-modal-content');
    if (!modalContent) return;
    const variantPicker = /** @type {VariantPicker | null} */ (modalContent.querySelector('variant-picker'));
    if (!variantPicker) return;
    variantPicker.updateVariantPicker(newHtml);
  }

  /**
   * Handles quick add button click
   * @param {Event} event - The click event
   */
  handleClick = async (event) => {
    event.preventDefault();

    const currentUrl = this.productPageUrl;

    if (this.dataset.usesSellingPlans === 'true') {
      if (currentUrl) window.location.href = currentUrl;
      return;
    }

    // Check if we have cached content for this URL
    let productGrid = this.#cachedContent.get(currentUrl);

    if (!productGrid) {
      // Fetch and cache the content
      const html = await this.fetchProductPage(currentUrl);
      if (html) {
        const gridElement = html.querySelector('[data-product-grid-content]');
        if (gridElement) {
          // Cache the cloned element to avoid modifying the original
          productGrid = /** @type {Element} */ (gridElement.cloneNode(true));
          this.#cachedContent.set(currentUrl, productGrid);
        }
      }
    }

    if (productGrid) {
      // Use a fresh clone from the cache
      const freshContent = /** @type {Element} */ (productGrid.cloneNode(true));
      await this.updateQuickAddModal(freshContent);
      this.#updateVariantPicker(productGrid);
    }

    this.#openQuickAddModal();
  };

  #resetScroll() {
    const dialogComponent = document.getElementById('quick-add-dialog');
    if (!(dialogComponent instanceof QuickAddDialog)) return;

    const productDetails = dialogComponent.querySelector('.product-details');
    const productMedia = dialogComponent.querySelector('.product-information__media');
    productDetails?.scrollTo({ top: 0, behavior: 'instant' });
    productMedia?.scrollTo({ top: 0, behavior: 'instant' });
  }

  /** @param {QuickAddDialog} dialogComponent */
  #stayVisibleUntilDialogCloses(dialogComponent) {
    this.toggleAttribute('stay-visible', true);

    dialogComponent.addEventListener(DialogCloseEvent.eventName, () => this.toggleAttribute('stay-visible', false), {
      once: true,
    });
  }

  #openQuickAddModal = () => {
    const dialogComponent = document.getElementById('quick-add-dialog');
    if (!(dialogComponent instanceof QuickAddDialog)) return;

    this.#stayVisibleUntilDialogCloses(dialogComponent);

    dialogComponent.showDialog();

    // is nondeterministic when the open attribute is set on the dialog element after .showDialog() is called.
    // Waiting until the open animation starts seemed to be the most reliable metric here.
    const dialog = dialogComponent.refs?.dialog;
    if (!dialog) return;
    dialog.addEventListener('animationstart', this.#resetScroll.bind(this), { once: true });
  };

  #closeQuickAddModal = () => {
    const dialogComponent = document.getElementById('quick-add-dialog');
    if (!(dialogComponent instanceof QuickAddDialog)) return;

    dialogComponent.closeDialog();
  };

  /**
   * Fetches the product page content
   * @param {string} productPageUrl - The URL of the product page to fetch
   * @returns {Promise<Document | null>}
   */
  async fetchProductPage(productPageUrl) {
    if (!productPageUrl) return null;

    // We use this to abort the previous fetch request if it's still pending.
    this.#abortController?.abort();
    this.#abortController = new AbortController();

    try {
      const response = await fetch(productPageUrl, {
        signal: this.#abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch product page: HTTP error ${response.status}`);
      }

      const responseText = await response.text();
      const html = new DOMParser().parseFromString(responseText, 'text/html');

      return html;
    } catch (error) {
      if (error.name === 'AbortError') {
        return null;
      } else {
        throw error;
      }
    } finally {
      this.#abortController = null;
    }
  }

  /**
   * Re-renders the variant picker.
   * @param {Element} productGrid - The product grid element
   */
  async updateQuickAddModal(productGrid) {
    const modalContent = document.getElementById('quick-add-modal-content');

    if (!productGrid || !modalContent) return;

    const productDetails = productGrid.querySelector('.product-details');
    const productMedia = productGrid.querySelector('.product-information__media');
    const buyButtonsBlock = productGrid.querySelector('.buy-buttons-block') || productGrid.querySelector('product-form-component');
    const variantPicker = productGrid.querySelector('variant-picker');
    const productPrice = productGrid.querySelector('product-price');
    const productDescription = productGrid.querySelector('rte-formatter') ||
                               productGrid.querySelector('.product__description') ||
                               productGrid.querySelector('[data-testid="product-description"]');

    if (productDetails) {
      // 1. Title and price (and description) grouped in one div/element
      const titlePriceWrapper = document.createElement('div');
      titlePriceWrapper.classList.add('product-title-price', 'product-header');

      const existingTitle = productGrid.querySelector('.view-product-title a')?.textContent?.trim() ||
                            productGrid.querySelector('h1')?.textContent?.trim() ||
                            '';
      const productTitle = document.createElement('a');
      productTitle.textContent = this.dataset.productTitle || existingTitle;
      productTitle.href = this.productPageUrl;
      productTitle.classList.add('product-title-link');

      titlePriceWrapper.appendChild(productTitle);
      if (productPrice) {
        titlePriceWrapper.appendChild(productPrice);
      }
      if (productDescription) {
        titlePriceWrapper.appendChild(productDescription);
      }

      // 2. Header row that moves the thumbnail inside product-details alongside the title & price element
      const headerRow = document.createElement('div');
      headerRow.classList.add('product-header-row');

      if (productMedia) {
        headerRow.appendChild(productMedia);
      }
      headerRow.appendChild(titlePriceWrapper);

      // 3. Populate product-details with the 4-row layout:
      // Row 1: Header row (thumbnail + title & price in one element)
      // Row 2: Variant picker (Color swatches + Size dropdown)
      // Row 4: Buy buttons block (Add to cart button)
      productDetails.innerHTML = '';
      productDetails.appendChild(headerRow);

      if (variantPicker) {
        productDetails.appendChild(variantPicker);
      }
      if (buyButtonsBlock) {
        this.#setupTissoButton(buyButtonsBlock);
        productDetails.appendChild(buyButtonsBlock);
      }
    }

    // Sync the view-event-payload attribute and morph children into the modal's product-component
    const payload = productGrid.getAttribute('view-event-payload') || '';
    modalContent.setAttribute('view-event-payload', payload);

    morph(modalContent, productGrid);

    this.#setupTissoButton(modalContent);
    this.#setupModalVariantPicker(modalContent);
    this.#syncVariantSelection(modalContent);
  }

  /**
   * Sets up variant picker options inside the quick-add modal:
   * - Adds text labels to color swatches if needed
   * - Converts Size options into a Figma dropdown (Component 213)
   * @param {Element} container - The container element
   */
  #setupModalVariantPicker(container) {
    if (!container) return;

    // 1. Swatches: Ensure variant label text is displayed inside the button label
    container.querySelectorAll('.variant-option__button-label--has-swatch').forEach((label) => {
      if (!label.querySelector('.variant-option__button-label__text')) {
        const input = label.querySelector('input');
        if (input && input.value) {
          const textSpan = document.createElement('span');
          textSpan.className = 'variant-option__button-label__text';
          textSpan.textContent = input.value;
          label.appendChild(textSpan);
        }
      }
    });

    // 2. Size: Convert size fieldset into a clean dropdown
    const sizeFieldset = Array.from(container.querySelectorAll('fieldset.variant-option')).find((fs) => {
      const legend = fs.querySelector('legend');
      return legend && legend.textContent.trim().toLowerCase().includes('size');
    });

    if (sizeFieldset && !sizeFieldset.classList.contains('variant-option--size-dropdown-initialized')) {
      sizeFieldset.classList.add('variant-option--size-dropdown-initialized');

      const legendText = sizeFieldset.querySelector('legend')?.childNodes[0]?.textContent?.trim() || 'Size';
      const radioInputs = Array.from(sizeFieldset.querySelectorAll('input[type="radio"]'));

      if (radioInputs.length > 0) {
        const wrapper = document.createElement('div');
        wrapper.className = 'variant-option variant-option--dropdowns variant-option--size-dropdown';
        wrapper.dataset.componentId = '213';

        const label = document.createElement('label');
        label.textContent = legendText;
        wrapper.appendChild(label);

        const selectWrapper = document.createElement('div');
        selectWrapper.className = 'variant-option__select-wrapper';

        const select = document.createElement('select');
        select.className = 'variant-option__select';
        select.name = radioInputs[0].name;

        const defaultOpt = document.createElement('option');
        defaultOpt.value = '';
        defaultOpt.disabled = true;
        defaultOpt.textContent = 'Choose your size';
        select.appendChild(defaultOpt);

        let hasSelected = false;
        radioInputs.forEach((radio) => {
          const opt = document.createElement('option');
          opt.value = radio.value;
          opt.textContent = radio.value;
          if (radio.checked) {
            opt.selected = true;
            hasSelected = true;
          }
          select.appendChild(opt);
        });

        if (!hasSelected) {
          defaultOpt.selected = true;
        }

        select.addEventListener('change', () => {
          const chosenRadio = radioInputs.find((r) => r.value === select.value);
          if (chosenRadio) {
            chosenRadio.checked = true;
            chosenRadio.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });

        const caretBox = document.createElement('div');
        caretBox.className = 'variant-option__caret-box';
        caretBox.innerHTML = `
          <svg aria-hidden="true" focusable="false" class="icon icon-caret" viewBox="0 0 10 6">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M9.354.646a.5.5 0 0 0-.708 0L5 4.293 1.354.646a.5.5 0 0 0-.708.708l4 4a.5.5 0 0 0 0-.708" fill="currentColor"/>
          </svg>
        `;

        selectWrapper.appendChild(select);
        selectWrapper.appendChild(caretBox);
        wrapper.appendChild(selectWrapper);

        sizeFieldset.style.display = 'none';
        sizeFieldset.parentNode.insertBefore(wrapper, sizeFieldset);
      }
    }
  }

  /**
   * Transforms the add-to-cart button inside the quick-add popup into the TISSO signature arrow button
   * @param {Element} container - The container element
   */
  #setupTissoButton(container) {
    if (!container) return;
    const atcBtn = container.querySelector('button.add-to-cart-button') || container.querySelector('button[type="submit"][name="add"]');
    if (!atcBtn) return;

    atcBtn.className = 'tisso-btn tisso-btn--black w-full add-to-cart-button button';

    const cartIcon = atcBtn.querySelector('.add-to-cart-icon');
    if (cartIcon) cartIcon.remove();

    const addedIcon = atcBtn.querySelector('.add-to-cart__added');
    if (addedIcon) addedIcon.remove();

    if (!atcBtn.querySelector('.tisso-btn__arrow')) {
      const label = atcBtn.querySelector('.tisso-btn__label')?.textContent?.trim() || atcBtn.textContent.trim().replace(/\s+/g, ' ') || 'Add to cart';
      atcBtn.innerHTML = `
        <span class="tisso-btn__label">${label}</span>
        <span class="tisso-btn__arrow" aria-hidden="true">
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 1L15 6M15 6L10 11M15 6H1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>
      `;
    }
  }

  /**
   * Syncs the variant selection from the product card to the modal
   * @param {Element} modalContent - The modal content element
   */
  #syncVariantSelection(modalContent) {
    const selectedVariantId = this.#getSelectedVariantId();
    if (!selectedVariantId) return;

    // Find and check the corresponding input in the modal
    const modalInputs = modalContent.querySelectorAll('input[type="radio"][data-variant-id]');
    for (const input of modalInputs) {
      if (input instanceof HTMLInputElement && input.dataset.variantId === selectedVariantId && !input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
    }
  }
}

if (!customElements.get('quick-add-component')) {
  customElements.define('quick-add-component', QuickAddComponent);
}

class QuickAddDialog extends DialogComponent {
  #abortController = new AbortController();

  connectedCallback() {
    super.connectedCallback();

    this.addEventListener(StandardEvents.cartLinesUpdate, this.handleCartUpdate, {
      signal: this.#abortController.signal,
    });
    this.addEventListener(StandardEvents.productSelect, this.#handleProductSelect);

    this.addEventListener(DialogCloseEvent.eventName, this.#handleDialogClose);
  }

  disconnectedCallback() {
    super.disconnectedCallback();

    this.#abortController.abort();
    this.removeEventListener(DialogCloseEvent.eventName, this.#handleDialogClose);
  }

  /**
   * Closes the dialog on successful cart update
   * @param {CartLinesUpdateEvent} event - The cart lines update event
   */
  handleCartUpdate = (event) => {
    event.promise
      ?.then(({ detail }) => {
        if (detail?.didError) return;
        this.closeDialog();
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[quick-add] Event promise rejected:', error);
      });
  };

  /** @param {ProductSelectEvent} event - The product select event */
  #handleProductSelect = (event) => {
    // Wait for variant update data
    event.promise
      .then(({ detail }) => {
        if (!detail?.html) return;

        const { html } = detail;
        const anchorElement = /** @type {HTMLAnchorElement} */ (html.querySelector('.view-product-title a'));
        const viewMoreDetailsLink = /** @type {HTMLAnchorElement} */ (this.querySelector('.view-product-title a'));
        const mobileProductTitle = /** @type {HTMLAnchorElement} */ (this.querySelector('.product-header a'));

        if (!anchorElement) return;

        if (viewMoreDetailsLink) viewMoreDetailsLink.href = anchorElement.href;
        if (mobileProductTitle) mobileProductTitle.href = anchorElement.href;
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') console.warn('[quick-add] Event promise rejected:', error);
      });
  };

  #handleDialogClose = () => {
    const iosVersion = getIOSVersion();
    /**
     * This is a patch to solve an issue with the UI freezing when the dialog is closed.
     * To reproduce it, use iOS 16.0.
     */
    if (!iosVersion || iosVersion.major >= 17 || (iosVersion.major === 16 && iosVersion.minor >= 4)) return;

    requestAnimationFrame(() => {
      /** @type {HTMLElement | null} */
      const grid = document.querySelector('#ResultsList [product-grid-view]');
      if (grid) {
        const currentWidth = grid.getBoundingClientRect().width;
        grid.style.width = `${currentWidth - 1}px`;
        requestAnimationFrame(() => {
          grid.style.width = '';
        });
      }
    });
  };
}

if (!customElements.get('quick-add-dialog')) {
  customElements.define('quick-add-dialog', QuickAddDialog);
}
