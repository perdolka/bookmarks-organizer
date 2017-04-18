'use strict';

/* global STATUS */

const MIN_PROGRESS = 0.01;
const UI_PAGE = 'html/ui.html';

/**
 * @exports bookmarksorganizer
 */
const bookmarksorganizer = {
  /**
   * Limits the number of queried bookmarks. A value of 0 disables the limit. It's always 0, there is no user setting
   * (yet).
   *
   * @type {integer}
   */
  LIMIT : 0,

  /**
   * Max attempts to try to connect to a url. It's always 2, there is no user setting (yet).
   *
   * @type {integer}
   */
  MAX_ATTEMPTS : 2,

  /**
   * Enables or disables the debug mode. It defaults to false and can be enabled in the add-on's settings.
   *
   * @type {integer}
   */
  debugEnabled : false,
  inProgress : false,
  internalCounter : 0,
  totalBookmarks : 0,
  checkedBookmarks : 0,
  bookmarkErrors : 0,
  bookmarkWarnings : 0,
  bookmarksResult : [],
  additionalData : [],
  debug : [],

  onBookmarkCreated () {
    browser.runtime.sendMessage({
      message : 'total-bookmarks-changed',
      total_bookmarks : ++bookmarksorganizer.totalBookmarks
    });
  },

  onBookmarkRemoved () {
    browser.runtime.sendMessage({
      message : 'total-bookmarks-changed',
      total_bookmarks : --bookmarksorganizer.totalBookmarks
    });
  },

  /**
   * Fired whenever the user changes the input, after the user has started interacting with the add-on by entering
   * its keyword in the address bar and then pressing the space key.
   *
   * @param {string} input - user input in the address bar, not including the add-on's keyword itself or the space
   *                 after the keyword.<br /><br />
   *                 <strong>Supported values:</strong> duplicates, empty-names, errors, organizer, redirects
   * @param {function} suggest - a callback function that the event listener can call to supply suggestions for the
   *                   address bar's drop-down list.
   *
   * @returns {void}
   */
  showOmniboxSuggestions (input, suggest) {
    const availableCommands = ['duplicates', 'empty-names', 'errors', 'organizer', 'redirects'];
    const suggestions = [];

    for (const command of availableCommands) {
      if (command.indexOf(input) !== -1) {
        suggestions.push({
          content : command,
          description : browser.i18n.getMessage('omnibox_command_check_' + command.replace('-', '_'))
        });
      }

      if (suggestions.length === 0) {
        suggestions.push({
          content : 'organizer',
          description : browser.i18n.getMessage('omnibox_command_open')
        });
      }
    }

    suggest(suggestions);
  },

  /**
   * fired when the user has selected one of the suggestions the add-on has added to the address bar's drop-down list.
   *
   * @param {string} input - this is the value that the user selected.
   *
   * @returns {void}
   */
  callOmniboxAction (input) {
    bookmarksorganizer.openUserInterfaceInCurrentTab();
    switch (input) {
      case 'errors':
        bookmarksorganizer.execute('broken-bookmarks', 'errors');
        break;
      case 'redirects':
        bookmarksorganizer.execute('broken-bookmarks', 'warnings');
        break;
      case 'duplicates':
        bookmarksorganizer.execute('duplicates', 'all');
        break;
      case 'empty-names':
        bookmarksorganizer.execute('empty-names', 'all');
        break;
      case 'organizer':
      default:
        bookmarksorganizer.openUserInterfaceInCurrentTab();
    }
  },

  openUserInterface () {
    const url = browser.extension.getURL(UI_PAGE);

    browser.tabs.query({}, (tabs) => {
      let tabId = null;

      for (const tab of tabs) {
        if (tab.url === url) {
          tabId = tab.id;
          break;
        }
      }

      if (tabId) {
        browser.tabs.update(tabId, { active : true });
      }
      else {
        browser.tabs.create({ url });
      }
    });
  },

  openUserInterfaceInCurrentTab () {
    browser.tabs.update(null, { url : browser.extension.getURL(UI_PAGE) });
  },

  async handleResponse (response) {
    if (response.message === 'count') {
      bookmarksorganizer.initBookmarkCount();
    }
    else if (response.message === 'execute') {
      if (!bookmarksorganizer.inProgress) {
        bookmarksorganizer.execute(response.mode, 'all');
      }
    }
    else if (response.message === 'edit') {
      await browser.bookmarks.update(response.bookmarkId, {
        title : response.title,
        url : response.url
      });

      if (response.mode === 'duplicate') {
        browser.runtime.sendMessage({
          message : 'update-listitem',
          bookmarkId : response.bookmarkId,
          title : response.title,
          path : bookmarksorganizer.additionalData[response.bookmarkId].path,
          mode : response.mode
        });
      }
      else {
        const bookmarks = await browser.bookmarks.get(response.bookmarkId);
        browser.runtime.sendMessage({
          message : 'update-listitem',
          bookmarkId : response.bookmarkId,
          bookmark : bookmarks[0],
          mode : response.mode
        });
      }
    }
    else if (response.message === 'remove') {
      browser.bookmarks.remove(response.bookmarkId);
      bookmarksorganizer.totalBookmarks--;
    }
    else if (response.message === 'repair-redirect') {
      browser.bookmarks.update(response.bookmarkId, { url : response.newUrl });
    }
  },

  async initBookmarkCount () {
    bookmarksorganizer.totalBookmarks = 0;

    const bookmarks = await browser.bookmarks.getTree();
    bookmarksorganizer.countBookmarks(bookmarks[0]);

    browser.runtime.sendMessage({
      message : 'total-bookmarks',
      total_bookmarks : bookmarksorganizer.totalBookmarks
    });
  },

  countBookmarks (bookmark) {
    if (bookmark.url) {
      if (bookmarksorganizer.LIMIT > 0 && bookmarksorganizer.totalBookmarks === bookmarksorganizer.LIMIT) {
        return;
      }

      bookmarksorganizer.totalBookmarks++;
    }

    if (bookmark.children) {
      for (const child of bookmark.children) {
        bookmarksorganizer.countBookmarks(child);
      }
    }
  },

  async execute (mode, type) {
    bookmarksorganizer.inProgress = true;
    bookmarksorganizer.internalCounter = 0;
    bookmarksorganizer.checkedBookmarks = 0;
    bookmarksorganizer.bookmarkErrors = 0;
    bookmarksorganizer.bookmarkWarnings = 0;
    bookmarksorganizer.bookmarksResult = [];
    bookmarksorganizer.additionalData = [];
    bookmarksorganizer.debug = [];

    browser.runtime.sendMessage({ message : 'started' });

    browser.storage.local.get('debug_enabled', (options) => {
      bookmarksorganizer.debugEnabled = options.debugEnabled;
    });

    const bookmarks = await browser.bookmarks.getTree();
    bookmarksorganizer.getBookmarkPath(bookmarks[0], [], bookmarksorganizer.additionalData);
    bookmarksorganizer.checkAllBookmarks(bookmarks[0], mode, type);

    if (mode === 'duplicates') {
      bookmarksorganizer.checkForDuplicates();
    }
  },

  getBookmarkPath (bookmark, path, map) {
    if (bookmark.title) {
      path.push(bookmark.title);
    }

    if (bookmark.children) {
      for (const childNode of bookmark.children) {
        bookmarksorganizer.getBookmarkPath(childNode, path, map);
      }
    }
    else {
      if (!map[bookmark.id]) {
        map[bookmark.id] = {};
      }

      map[bookmark.id].path = path.slice(0, -1);
    }

    path.pop();

    return map;
  },

  checkAllBookmarks (bookmark, mode, type) {
    switch (mode) {
      case 'broken-bookmarks':
        bookmarksorganizer.checkForBrokenBookmark(bookmark, mode, type);
        break;
      case 'duplicates':
        bookmarksorganizer.checkBookmarkAndAssignPath(bookmark, mode);
        break;
      case 'empty-names':
        bookmarksorganizer.checkForEmptyName(bookmark, mode);
        break;
      default:
        // do nothing
    }

    if (bookmark.children) {
      for (const child of bookmark.children) {
        bookmarksorganizer.checkAllBookmarks(child, mode, type);
      }
    }
  },

  async checkForBrokenBookmark (bookmark, mode, type) {
    if (bookmark.url) {
      if (bookmarksorganizer.LIMIT > 0 && bookmarksorganizer.internalCounter === bookmarksorganizer.LIMIT) {
        return;
      }

      bookmarksorganizer.internalCounter++;

      if (bookmark.url.match(/^https?:\/\//)) {
        bookmark.attempts = 0;

        const checkedBookmark = await bookmarksorganizer.checkHttpResponse(bookmark);
        bookmarksorganizer.checkedBookmarks++;

        switch (checkedBookmark.status) {
          case STATUS.REDIRECT:
            if (type === 'all' || type === 'warnings') {
              bookmarksorganizer.bookmarkWarnings++;
              bookmarksorganizer.bookmarksResult.push(checkedBookmark);
            }
            break;
          case STATUS.NOT_FOUND:
          case STATUS.FETCH_ERROR:
            if (type === 'all' || type === 'errors') {
              bookmarksorganizer.bookmarkErrors++;
              bookmarksorganizer.bookmarksResult.push(checkedBookmark);
            }
            break;
          default:
            // do nothing
        }

        bookmarksorganizer.updateProgressUi(mode, true);
      }
      else {
        bookmarksorganizer.checkedBookmarks++;
        bookmarksorganizer.updateProgressUi(mode, true);
      }
    }
    else {
      bookmarksorganizer.bookmarksResult.push(bookmark);
    }
  },

  async checkHttpResponse (bookmark) {
    bookmark.attempts++;

    try {
      const response = await fetch(bookmark.url, {
        credentials : 'include',
        cache : 'no-store'
      });

      if (response.redirected) {
        // redirect to identical url. That's weird but there are cases in the real world…
        if (bookmark.url === response.url) {
          bookmark.status = STATUS.OK;
        }
        // redirect to another url
        else {
          bookmark.status = STATUS.REDIRECT;
        }

        bookmark.newUrl = response.url;
      }
      else {
        bookmark.status = response.status;
      }

      if (bookmarksorganizer.debugEnabled) {
        bookmarksorganizer.debug.push({
          bookmark : {
            id : bookmark.id,
            parentId : bookmark.parentId,
            title : bookmark.title,
            url : bookmark.url,
            status : bookmark.status
          },
          cause : 'server-response',
          response : {
            url : response.url,
            redirected : response.redirected,
            status : response.status
          }
        });
      }
    }
    catch (error) {
      bookmark.status = STATUS.FETCH_ERROR;

      if (bookmarksorganizer.debugEnabled) {
        bookmarksorganizer.debug.push({
          bookmark : {
            id : bookmark.id,
            parentId : bookmark.parentId,
            title : bookmark.title,
            url : bookmark.url,
            status : bookmark.status
          },
          cause : 'fetch-error',
          response : error.message
        });
      }

      if (bookmark.attempts < bookmarksorganizer.MAX_ATTEMPTS) {
        await bookmarksorganizer.checkHttpResponse(bookmark);
      }
    }

    return bookmark;
  },

  checkBookmarkAndAssignPath (bookmark, mode) {
    if (bookmark.url) {
      if (bookmarksorganizer.LIMIT > 0 && bookmarksorganizer.internalCounter === bookmarksorganizer.LIMIT) {
        return;
      }

      bookmark.path = bookmarksorganizer.additionalData[bookmark.id].path;

      bookmarksorganizer.internalCounter++;
      bookmarksorganizer.checkedBookmarks++;
      bookmarksorganizer.updateProgressUi(mode, false);
    }

    bookmarksorganizer.bookmarksResult.push(bookmark);
  },

  checkForEmptyName (bookmark, mode) {
    if (bookmark.url) {
      if (bookmarksorganizer.LIMIT > 0 && bookmarksorganizer.internalCounter === bookmarksorganizer.LIMIT) {
        return;
      }

      bookmarksorganizer.internalCounter++;

      if (!bookmark.title) {
        bookmarksorganizer.bookmarkErrors++;
        bookmarksorganizer.bookmarksResult.push(bookmark);
      }

      bookmarksorganizer.checkedBookmarks++;
      bookmarksorganizer.updateProgressUi(mode, true);
    }
    else {
      bookmarksorganizer.bookmarksResult.push(bookmark);
    }
  },

  checkForDuplicates () {
    const duplicates = { };

    bookmarksorganizer.bookmarksResult.forEach((bookmark) => {
      if (bookmark.url) {
        if (duplicates[bookmark.url]) {
          duplicates[bookmark.url].push(bookmark);
        }
        else {
          duplicates[bookmark.url] = [bookmark];
        }
      }
    });

    Object.keys(duplicates).forEach((key) => {
      if (duplicates[key].length < 2) {
        delete duplicates[key];
      }
      else {
        bookmarksorganizer.bookmarkErrors++;
      }
    });

    browser.runtime.sendMessage({
      message : 'show-duplicates-ui',
      bookmarks : duplicates,
      errors : bookmarksorganizer.bookmarkErrors
    });

    bookmarksorganizer.inProgress = false;
  },

  updateProgressUi (mode, checkForFinish) {
    let progress = bookmarksorganizer.checkedBookmarks / bookmarksorganizer.totalBookmarks;
    if (progress < MIN_PROGRESS) {
      progress = MIN_PROGRESS;
    }

    browser.runtime.sendMessage({
      message : 'update-counters',
      total_bookmarks : bookmarksorganizer.totalBookmarks,
      checked_bookmarks : bookmarksorganizer.checkedBookmarks,
      bookmarks_errors : bookmarksorganizer.bookmarkErrors,
      bookmarks_warnings : bookmarksorganizer.bookmarkWarnings,
      progress : progress
    });

    if (checkForFinish && bookmarksorganizer.checkedBookmarks === bookmarksorganizer.totalBookmarks) {
      const bookmarks = bookmarksorganizer.buildResultArray(bookmarksorganizer.bookmarksResult)[0].children;

      browser.runtime.sendMessage({
        message : 'finished',
        mode : mode,
        bookmarks : bookmarks,
        debug : bookmarksorganizer.debug
      });

      bookmarksorganizer.inProgress = false;
    }
  },

  buildResultArray (bookmarks) {
    const result = [];
    const mappedArray = {};
    let mappedElement = null;

    for (const bookmark of bookmarks) {
      mappedArray[bookmark.id] = bookmark;
      mappedArray[bookmark.id].children = [];
    }

    for (const id in mappedArray) {
      if (Object.prototype.hasOwnProperty.call(mappedArray, id)) {
        mappedElement = mappedArray[id];
        if (mappedElement.parentId) {
          mappedArray[mappedElement.parentId].children.push(mappedElement);
        }
        else {
          result.push(mappedElement);
        }
      }
    }

    return result;
  }
};

browser.bookmarks.onCreated.addListener(bookmarksorganizer.onBookmarkCreated);
browser.bookmarks.onRemoved.addListener(bookmarksorganizer.onBookmarkRemoved);
browser.browserAction.onClicked.addListener(bookmarksorganizer.openUserInterface);
browser.omnibox.onInputChanged.addListener(bookmarksorganizer.showOmniboxSuggestions);
browser.omnibox.onInputEntered.addListener(bookmarksorganizer.callOmniboxAction);
browser.omnibox.setDefaultSuggestion({ description : browser.i18n.getMessage('omnibox_default_description') });
browser.runtime.onMessage.addListener(bookmarksorganizer.handleResponse);
