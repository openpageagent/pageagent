// The application contract is shared by ARP, the host, the editor and the SDK.
(function (root) {
  'use strict';
  var VERSION = 1;
  var CAPABILITIES = ['data.read', 'data.write', 'data.delete', 'actions.run'];
  // All 675 distinct icons in the bundled FontAwesome 4.7 font; aliases share a glyph.
  var ICONS = {
    'fa-glass': '\uf000', 'fa-music': '\uf001', 'fa-search': '\uf002',
    'fa-envelope-o': '\uf003', 'fa-heart': '\uf004', 'fa-star': '\uf005',
    'fa-star-o': '\uf006', 'fa-user': '\uf007', 'fa-film': '\uf008',
    'fa-th-large': '\uf009', 'fa-th': '\uf00a', 'fa-th-list': '\uf00b',
    'fa-check': '\uf00c', 'fa-times': '\uf00d', 'fa-search-plus': '\uf00e',
    'fa-search-minus': '\uf010', 'fa-power-off': '\uf011', 'fa-signal': '\uf012',
    'fa-cog': '\uf013', 'fa-trash-o': '\uf014', 'fa-home': '\uf015',
    'fa-file-o': '\uf016', 'fa-clock-o': '\uf017', 'fa-road': '\uf018',
    'fa-download': '\uf019', 'fa-arrow-circle-o-down': '\uf01a', 'fa-arrow-circle-o-up': '\uf01b',
    'fa-inbox': '\uf01c', 'fa-play-circle-o': '\uf01d', 'fa-repeat': '\uf01e',
    'fa-refresh': '\uf021', 'fa-list-alt': '\uf022', 'fa-lock': '\uf023',
    'fa-flag': '\uf024', 'fa-headphones': '\uf025', 'fa-volume-off': '\uf026',
    'fa-volume-down': '\uf027', 'fa-volume-up': '\uf028', 'fa-qrcode': '\uf029',
    'fa-barcode': '\uf02a', 'fa-tag': '\uf02b', 'fa-tags': '\uf02c',
    'fa-book': '\uf02d', 'fa-bookmark': '\uf02e', 'fa-print': '\uf02f',
    'fa-camera': '\uf030', 'fa-font': '\uf031', 'fa-bold': '\uf032',
    'fa-italic': '\uf033', 'fa-text-height': '\uf034', 'fa-text-width': '\uf035',
    'fa-align-left': '\uf036', 'fa-align-center': '\uf037', 'fa-align-right': '\uf038',
    'fa-align-justify': '\uf039', 'fa-list': '\uf03a', 'fa-outdent': '\uf03b',
    'fa-indent': '\uf03c', 'fa-video-camera': '\uf03d', 'fa-picture-o': '\uf03e',
    'fa-pencil': '\uf040', 'fa-map-marker': '\uf041', 'fa-adjust': '\uf042',
    'fa-tint': '\uf043', 'fa-pencil-square-o': '\uf044', 'fa-share-square-o': '\uf045',
    'fa-check-square-o': '\uf046', 'fa-arrows': '\uf047', 'fa-step-backward': '\uf048',
    'fa-fast-backward': '\uf049', 'fa-backward': '\uf04a', 'fa-play': '\uf04b',
    'fa-pause': '\uf04c', 'fa-stop': '\uf04d', 'fa-forward': '\uf04e',
    'fa-fast-forward': '\uf050', 'fa-step-forward': '\uf051', 'fa-eject': '\uf052',
    'fa-chevron-left': '\uf053', 'fa-chevron-right': '\uf054', 'fa-plus-circle': '\uf055',
    'fa-minus-circle': '\uf056', 'fa-times-circle': '\uf057', 'fa-check-circle': '\uf058',
    'fa-question-circle': '\uf059', 'fa-info-circle': '\uf05a', 'fa-crosshairs': '\uf05b',
    'fa-times-circle-o': '\uf05c', 'fa-check-circle-o': '\uf05d', 'fa-ban': '\uf05e',
    'fa-arrow-left': '\uf060', 'fa-arrow-right': '\uf061', 'fa-arrow-up': '\uf062',
    'fa-arrow-down': '\uf063', 'fa-share': '\uf064', 'fa-expand': '\uf065',
    'fa-compress': '\uf066', 'fa-plus': '\uf067', 'fa-minus': '\uf068',
    'fa-asterisk': '\uf069', 'fa-exclamation-circle': '\uf06a', 'fa-gift': '\uf06b',
    'fa-leaf': '\uf06c', 'fa-fire': '\uf06d', 'fa-eye': '\uf06e',
    'fa-eye-slash': '\uf070', 'fa-exclamation-triangle': '\uf071', 'fa-plane': '\uf072',
    'fa-calendar': '\uf073', 'fa-random': '\uf074', 'fa-comment': '\uf075',
    'fa-magnet': '\uf076', 'fa-chevron-up': '\uf077', 'fa-chevron-down': '\uf078',
    'fa-retweet': '\uf079', 'fa-shopping-cart': '\uf07a', 'fa-folder': '\uf07b',
    'fa-folder-open': '\uf07c', 'fa-arrows-v': '\uf07d', 'fa-arrows-h': '\uf07e',
    'fa-bar-chart': '\uf080', 'fa-twitter-square': '\uf081', 'fa-facebook-square': '\uf082',
    'fa-camera-retro': '\uf083', 'fa-key': '\uf084', 'fa-cogs': '\uf085',
    'fa-comments': '\uf086', 'fa-thumbs-o-up': '\uf087', 'fa-thumbs-o-down': '\uf088',
    'fa-star-half': '\uf089', 'fa-heart-o': '\uf08a', 'fa-sign-out': '\uf08b',
    'fa-linkedin-square': '\uf08c', 'fa-thumb-tack': '\uf08d', 'fa-external-link': '\uf08e',
    'fa-sign-in': '\uf090', 'fa-trophy': '\uf091', 'fa-github-square': '\uf092',
    'fa-upload': '\uf093', 'fa-lemon-o': '\uf094', 'fa-phone': '\uf095',
    'fa-square-o': '\uf096', 'fa-bookmark-o': '\uf097', 'fa-phone-square': '\uf098',
    'fa-twitter': '\uf099', 'fa-facebook': '\uf09a', 'fa-github': '\uf09b',
    'fa-unlock': '\uf09c', 'fa-credit-card': '\uf09d', 'fa-rss': '\uf09e',
    'fa-hdd-o': '\uf0a0', 'fa-bullhorn': '\uf0a1', 'fa-bell-o': '\uf0a2',
    'fa-certificate': '\uf0a3', 'fa-hand-o-right': '\uf0a4', 'fa-hand-o-left': '\uf0a5',
    'fa-hand-o-up': '\uf0a6', 'fa-hand-o-down': '\uf0a7', 'fa-arrow-circle-left': '\uf0a8',
    'fa-arrow-circle-right': '\uf0a9', 'fa-arrow-circle-up': '\uf0aa', 'fa-arrow-circle-down': '\uf0ab',
    'fa-globe': '\uf0ac', 'fa-wrench': '\uf0ad', 'fa-tasks': '\uf0ae',
    'fa-filter': '\uf0b0', 'fa-briefcase': '\uf0b1', 'fa-arrows-alt': '\uf0b2',
    'fa-users': '\uf0c0', 'fa-link': '\uf0c1', 'fa-cloud': '\uf0c2',
    'fa-flask': '\uf0c3', 'fa-scissors': '\uf0c4', 'fa-files-o': '\uf0c5',
    'fa-paperclip': '\uf0c6', 'fa-floppy-o': '\uf0c7', 'fa-square': '\uf0c8',
    'fa-bars': '\uf0c9', 'fa-list-ul': '\uf0ca', 'fa-list-ol': '\uf0cb',
    'fa-strikethrough': '\uf0cc', 'fa-underline': '\uf0cd', 'fa-table': '\uf0ce',
    'fa-magic': '\uf0d0', 'fa-truck': '\uf0d1', 'fa-pinterest': '\uf0d2',
    'fa-pinterest-square': '\uf0d3', 'fa-google-plus-square': '\uf0d4', 'fa-google-plus': '\uf0d5',
    'fa-money': '\uf0d6', 'fa-caret-down': '\uf0d7', 'fa-caret-up': '\uf0d8',
    'fa-caret-left': '\uf0d9', 'fa-caret-right': '\uf0da', 'fa-columns': '\uf0db',
    'fa-sort': '\uf0dc', 'fa-sort-desc': '\uf0dd', 'fa-sort-asc': '\uf0de',
    'fa-envelope': '\uf0e0', 'fa-linkedin': '\uf0e1', 'fa-undo': '\uf0e2',
    'fa-gavel': '\uf0e3', 'fa-tachometer': '\uf0e4', 'fa-comment-o': '\uf0e5',
    'fa-comments-o': '\uf0e6', 'fa-bolt': '\uf0e7', 'fa-sitemap': '\uf0e8',
    'fa-umbrella': '\uf0e9', 'fa-clipboard': '\uf0ea', 'fa-lightbulb-o': '\uf0eb',
    'fa-exchange': '\uf0ec', 'fa-cloud-download': '\uf0ed', 'fa-cloud-upload': '\uf0ee',
    'fa-user-md': '\uf0f0', 'fa-stethoscope': '\uf0f1', 'fa-suitcase': '\uf0f2',
    'fa-bell': '\uf0f3', 'fa-coffee': '\uf0f4', 'fa-cutlery': '\uf0f5',
    'fa-file-text-o': '\uf0f6', 'fa-building-o': '\uf0f7', 'fa-hospital-o': '\uf0f8',
    'fa-ambulance': '\uf0f9', 'fa-medkit': '\uf0fa', 'fa-fighter-jet': '\uf0fb',
    'fa-beer': '\uf0fc', 'fa-h-square': '\uf0fd', 'fa-plus-square': '\uf0fe',
    'fa-angle-double-left': '\uf100', 'fa-angle-double-right': '\uf101', 'fa-angle-double-up': '\uf102',
    'fa-angle-double-down': '\uf103', 'fa-angle-left': '\uf104', 'fa-angle-right': '\uf105',
    'fa-angle-up': '\uf106', 'fa-angle-down': '\uf107', 'fa-desktop': '\uf108',
    'fa-laptop': '\uf109', 'fa-tablet': '\uf10a', 'fa-mobile': '\uf10b',
    'fa-circle-o': '\uf10c', 'fa-quote-left': '\uf10d', 'fa-quote-right': '\uf10e',
    'fa-spinner': '\uf110', 'fa-circle': '\uf111', 'fa-reply': '\uf112',
    'fa-github-alt': '\uf113', 'fa-folder-o': '\uf114', 'fa-folder-open-o': '\uf115',
    'fa-smile-o': '\uf118', 'fa-frown-o': '\uf119', 'fa-meh-o': '\uf11a',
    'fa-gamepad': '\uf11b', 'fa-keyboard-o': '\uf11c', 'fa-flag-o': '\uf11d',
    'fa-flag-checkered': '\uf11e', 'fa-terminal': '\uf120', 'fa-code': '\uf121',
    'fa-reply-all': '\uf122', 'fa-star-half-o': '\uf123', 'fa-location-arrow': '\uf124',
    'fa-crop': '\uf125', 'fa-code-fork': '\uf126', 'fa-chain-broken': '\uf127',
    'fa-question': '\uf128', 'fa-info': '\uf129', 'fa-exclamation': '\uf12a',
    'fa-superscript': '\uf12b', 'fa-subscript': '\uf12c', 'fa-eraser': '\uf12d',
    'fa-puzzle-piece': '\uf12e', 'fa-microphone': '\uf130', 'fa-microphone-slash': '\uf131',
    'fa-shield': '\uf132', 'fa-calendar-o': '\uf133', 'fa-fire-extinguisher': '\uf134',
    'fa-rocket': '\uf135', 'fa-maxcdn': '\uf136', 'fa-chevron-circle-left': '\uf137',
    'fa-chevron-circle-right': '\uf138', 'fa-chevron-circle-up': '\uf139', 'fa-chevron-circle-down': '\uf13a',
    'fa-html5': '\uf13b', 'fa-css3': '\uf13c', 'fa-anchor': '\uf13d',
    'fa-unlock-alt': '\uf13e', 'fa-bullseye': '\uf140', 'fa-ellipsis-h': '\uf141',
    'fa-ellipsis-v': '\uf142', 'fa-rss-square': '\uf143', 'fa-play-circle': '\uf144',
    'fa-ticket': '\uf145', 'fa-minus-square': '\uf146', 'fa-minus-square-o': '\uf147',
    'fa-level-up': '\uf148', 'fa-level-down': '\uf149', 'fa-check-square': '\uf14a',
    'fa-pencil-square': '\uf14b', 'fa-external-link-square': '\uf14c', 'fa-share-square': '\uf14d',
    'fa-compass': '\uf14e', 'fa-caret-square-o-down': '\uf150', 'fa-caret-square-o-up': '\uf151',
    'fa-caret-square-o-right': '\uf152', 'fa-eur': '\uf153', 'fa-gbp': '\uf154',
    'fa-usd': '\uf155', 'fa-inr': '\uf156', 'fa-jpy': '\uf157',
    'fa-rub': '\uf158', 'fa-krw': '\uf159', 'fa-btc': '\uf15a',
    'fa-file': '\uf15b', 'fa-file-text': '\uf15c', 'fa-sort-alpha-asc': '\uf15d',
    'fa-sort-alpha-desc': '\uf15e', 'fa-sort-amount-asc': '\uf160', 'fa-sort-amount-desc': '\uf161',
    'fa-sort-numeric-asc': '\uf162', 'fa-sort-numeric-desc': '\uf163', 'fa-thumbs-up': '\uf164',
    'fa-thumbs-down': '\uf165', 'fa-youtube-square': '\uf166', 'fa-youtube': '\uf167',
    'fa-xing': '\uf168', 'fa-xing-square': '\uf169', 'fa-youtube-play': '\uf16a',
    'fa-dropbox': '\uf16b', 'fa-stack-overflow': '\uf16c', 'fa-instagram': '\uf16d',
    'fa-flickr': '\uf16e', 'fa-adn': '\uf170', 'fa-bitbucket': '\uf171',
    'fa-bitbucket-square': '\uf172', 'fa-tumblr': '\uf173', 'fa-tumblr-square': '\uf174',
    'fa-long-arrow-down': '\uf175', 'fa-long-arrow-up': '\uf176', 'fa-long-arrow-left': '\uf177',
    'fa-long-arrow-right': '\uf178', 'fa-apple': '\uf179', 'fa-windows': '\uf17a',
    'fa-android': '\uf17b', 'fa-linux': '\uf17c', 'fa-dribbble': '\uf17d',
    'fa-skype': '\uf17e', 'fa-foursquare': '\uf180', 'fa-trello': '\uf181',
    'fa-female': '\uf182', 'fa-male': '\uf183', 'fa-gratipay': '\uf184',
    'fa-sun-o': '\uf185', 'fa-moon-o': '\uf186', 'fa-archive': '\uf187',
    'fa-bug': '\uf188', 'fa-vk': '\uf189', 'fa-weibo': '\uf18a',
    'fa-renren': '\uf18b', 'fa-pagelines': '\uf18c', 'fa-stack-exchange': '\uf18d',
    'fa-arrow-circle-o-right': '\uf18e', 'fa-arrow-circle-o-left': '\uf190', 'fa-caret-square-o-left': '\uf191',
    'fa-dot-circle-o': '\uf192', 'fa-wheelchair': '\uf193', 'fa-vimeo-square': '\uf194',
    'fa-try': '\uf195', 'fa-plus-square-o': '\uf196', 'fa-space-shuttle': '\uf197',
    'fa-slack': '\uf198', 'fa-envelope-square': '\uf199', 'fa-wordpress': '\uf19a',
    'fa-openid': '\uf19b', 'fa-university': '\uf19c', 'fa-graduation-cap': '\uf19d',
    'fa-yahoo': '\uf19e', 'fa-google': '\uf1a0', 'fa-reddit': '\uf1a1',
    'fa-reddit-square': '\uf1a2', 'fa-stumbleupon-circle': '\uf1a3', 'fa-stumbleupon': '\uf1a4',
    'fa-delicious': '\uf1a5', 'fa-digg': '\uf1a6', 'fa-pied-piper-pp': '\uf1a7',
    'fa-pied-piper-alt': '\uf1a8', 'fa-drupal': '\uf1a9', 'fa-joomla': '\uf1aa',
    'fa-language': '\uf1ab', 'fa-fax': '\uf1ac', 'fa-building': '\uf1ad',
    'fa-child': '\uf1ae', 'fa-paw': '\uf1b0', 'fa-spoon': '\uf1b1',
    'fa-cube': '\uf1b2', 'fa-cubes': '\uf1b3', 'fa-behance': '\uf1b4',
    'fa-behance-square': '\uf1b5', 'fa-steam': '\uf1b6', 'fa-steam-square': '\uf1b7',
    'fa-recycle': '\uf1b8', 'fa-car': '\uf1b9', 'fa-taxi': '\uf1ba',
    'fa-tree': '\uf1bb', 'fa-spotify': '\uf1bc', 'fa-deviantart': '\uf1bd',
    'fa-soundcloud': '\uf1be', 'fa-database': '\uf1c0', 'fa-file-pdf-o': '\uf1c1',
    'fa-file-word-o': '\uf1c2', 'fa-file-excel-o': '\uf1c3', 'fa-file-powerpoint-o': '\uf1c4',
    'fa-file-image-o': '\uf1c5', 'fa-file-archive-o': '\uf1c6', 'fa-file-audio-o': '\uf1c7',
    'fa-file-video-o': '\uf1c8', 'fa-file-code-o': '\uf1c9', 'fa-vine': '\uf1ca',
    'fa-codepen': '\uf1cb', 'fa-jsfiddle': '\uf1cc', 'fa-life-ring': '\uf1cd',
    'fa-circle-o-notch': '\uf1ce', 'fa-rebel': '\uf1d0', 'fa-empire': '\uf1d1',
    'fa-git-square': '\uf1d2', 'fa-git': '\uf1d3', 'fa-hacker-news': '\uf1d4',
    'fa-tencent-weibo': '\uf1d5', 'fa-qq': '\uf1d6', 'fa-weixin': '\uf1d7',
    'fa-paper-plane': '\uf1d8', 'fa-paper-plane-o': '\uf1d9', 'fa-history': '\uf1da',
    'fa-circle-thin': '\uf1db', 'fa-header': '\uf1dc', 'fa-paragraph': '\uf1dd',
    'fa-sliders': '\uf1de', 'fa-share-alt': '\uf1e0', 'fa-share-alt-square': '\uf1e1',
    'fa-bomb': '\uf1e2', 'fa-futbol-o': '\uf1e3', 'fa-tty': '\uf1e4',
    'fa-binoculars': '\uf1e5', 'fa-plug': '\uf1e6', 'fa-slideshare': '\uf1e7',
    'fa-twitch': '\uf1e8', 'fa-yelp': '\uf1e9', 'fa-newspaper-o': '\uf1ea',
    'fa-wifi': '\uf1eb', 'fa-calculator': '\uf1ec', 'fa-paypal': '\uf1ed',
    'fa-google-wallet': '\uf1ee', 'fa-cc-visa': '\uf1f0', 'fa-cc-mastercard': '\uf1f1',
    'fa-cc-discover': '\uf1f2', 'fa-cc-amex': '\uf1f3', 'fa-cc-paypal': '\uf1f4',
    'fa-cc-stripe': '\uf1f5', 'fa-bell-slash': '\uf1f6', 'fa-bell-slash-o': '\uf1f7',
    'fa-trash': '\uf1f8', 'fa-copyright': '\uf1f9', 'fa-at': '\uf1fa',
    'fa-eyedropper': '\uf1fb', 'fa-paint-brush': '\uf1fc', 'fa-birthday-cake': '\uf1fd',
    'fa-area-chart': '\uf1fe', 'fa-pie-chart': '\uf200', 'fa-line-chart': '\uf201',
    'fa-lastfm': '\uf202', 'fa-lastfm-square': '\uf203', 'fa-toggle-off': '\uf204',
    'fa-toggle-on': '\uf205', 'fa-bicycle': '\uf206', 'fa-bus': '\uf207',
    'fa-ioxhost': '\uf208', 'fa-angellist': '\uf209', 'fa-cc': '\uf20a',
    'fa-ils': '\uf20b', 'fa-meanpath': '\uf20c', 'fa-buysellads': '\uf20d',
    'fa-connectdevelop': '\uf20e', 'fa-dashcube': '\uf210', 'fa-forumbee': '\uf211',
    'fa-leanpub': '\uf212', 'fa-sellsy': '\uf213', 'fa-shirtsinbulk': '\uf214',
    'fa-simplybuilt': '\uf215', 'fa-skyatlas': '\uf216', 'fa-cart-plus': '\uf217',
    'fa-cart-arrow-down': '\uf218', 'fa-diamond': '\uf219', 'fa-ship': '\uf21a',
    'fa-user-secret': '\uf21b', 'fa-motorcycle': '\uf21c', 'fa-street-view': '\uf21d',
    'fa-heartbeat': '\uf21e', 'fa-venus': '\uf221', 'fa-mars': '\uf222',
    'fa-mercury': '\uf223', 'fa-transgender': '\uf224', 'fa-transgender-alt': '\uf225',
    'fa-venus-double': '\uf226', 'fa-mars-double': '\uf227', 'fa-venus-mars': '\uf228',
    'fa-mars-stroke': '\uf229', 'fa-mars-stroke-v': '\uf22a', 'fa-mars-stroke-h': '\uf22b',
    'fa-neuter': '\uf22c', 'fa-genderless': '\uf22d', 'fa-facebook-official': '\uf230',
    'fa-pinterest-p': '\uf231', 'fa-whatsapp': '\uf232', 'fa-server': '\uf233',
    'fa-user-plus': '\uf234', 'fa-user-times': '\uf235', 'fa-bed': '\uf236',
    'fa-viacoin': '\uf237', 'fa-train': '\uf238', 'fa-subway': '\uf239',
    'fa-medium': '\uf23a', 'fa-y-combinator': '\uf23b', 'fa-optin-monster': '\uf23c',
    'fa-opencart': '\uf23d', 'fa-expeditedssl': '\uf23e', 'fa-battery-full': '\uf240',
    'fa-battery-three-quarters': '\uf241', 'fa-battery-half': '\uf242', 'fa-battery-quarter': '\uf243',
    'fa-battery-empty': '\uf244', 'fa-mouse-pointer': '\uf245', 'fa-i-cursor': '\uf246',
    'fa-object-group': '\uf247', 'fa-object-ungroup': '\uf248', 'fa-sticky-note': '\uf249',
    'fa-sticky-note-o': '\uf24a', 'fa-cc-jcb': '\uf24b', 'fa-cc-diners-club': '\uf24c',
    'fa-clone': '\uf24d', 'fa-balance-scale': '\uf24e', 'fa-hourglass-o': '\uf250',
    'fa-hourglass-start': '\uf251', 'fa-hourglass-half': '\uf252', 'fa-hourglass-end': '\uf253',
    'fa-hourglass': '\uf254', 'fa-hand-rock-o': '\uf255', 'fa-hand-paper-o': '\uf256',
    'fa-hand-scissors-o': '\uf257', 'fa-hand-lizard-o': '\uf258', 'fa-hand-spock-o': '\uf259',
    'fa-hand-pointer-o': '\uf25a', 'fa-hand-peace-o': '\uf25b', 'fa-trademark': '\uf25c',
    'fa-registered': '\uf25d', 'fa-creative-commons': '\uf25e', 'fa-gg': '\uf260',
    'fa-gg-circle': '\uf261', 'fa-tripadvisor': '\uf262', 'fa-odnoklassniki': '\uf263',
    'fa-odnoklassniki-square': '\uf264', 'fa-get-pocket': '\uf265', 'fa-wikipedia-w': '\uf266',
    'fa-safari': '\uf267', 'fa-chrome': '\uf268', 'fa-firefox': '\uf269',
    'fa-opera': '\uf26a', 'fa-internet-explorer': '\uf26b', 'fa-television': '\uf26c',
    'fa-contao': '\uf26d', 'fa-500px': '\uf26e', 'fa-amazon': '\uf270',
    'fa-calendar-plus-o': '\uf271', 'fa-calendar-minus-o': '\uf272', 'fa-calendar-times-o': '\uf273',
    'fa-calendar-check-o': '\uf274', 'fa-industry': '\uf275', 'fa-map-pin': '\uf276',
    'fa-map-signs': '\uf277', 'fa-map-o': '\uf278', 'fa-map': '\uf279',
    'fa-commenting': '\uf27a', 'fa-commenting-o': '\uf27b', 'fa-houzz': '\uf27c',
    'fa-vimeo': '\uf27d', 'fa-black-tie': '\uf27e', 'fa-fonticons': '\uf280',
    'fa-reddit-alien': '\uf281', 'fa-edge': '\uf282', 'fa-credit-card-alt': '\uf283',
    'fa-codiepie': '\uf284', 'fa-modx': '\uf285', 'fa-fort-awesome': '\uf286',
    'fa-usb': '\uf287', 'fa-product-hunt': '\uf288', 'fa-mixcloud': '\uf289',
    'fa-scribd': '\uf28a', 'fa-pause-circle': '\uf28b', 'fa-pause-circle-o': '\uf28c',
    'fa-stop-circle': '\uf28d', 'fa-stop-circle-o': '\uf28e', 'fa-shopping-bag': '\uf290',
    'fa-shopping-basket': '\uf291', 'fa-hashtag': '\uf292', 'fa-bluetooth': '\uf293',
    'fa-bluetooth-b': '\uf294', 'fa-percent': '\uf295', 'fa-gitlab': '\uf296',
    'fa-wpbeginner': '\uf297', 'fa-wpforms': '\uf298', 'fa-envira': '\uf299',
    'fa-universal-access': '\uf29a', 'fa-wheelchair-alt': '\uf29b', 'fa-question-circle-o': '\uf29c',
    'fa-blind': '\uf29d', 'fa-audio-description': '\uf29e', 'fa-volume-control-phone': '\uf2a0',
    'fa-braille': '\uf2a1', 'fa-assistive-listening-systems': '\uf2a2', 'fa-american-sign-language-interpreting': '\uf2a3',
    'fa-deaf': '\uf2a4', 'fa-glide': '\uf2a5', 'fa-glide-g': '\uf2a6',
    'fa-sign-language': '\uf2a7', 'fa-low-vision': '\uf2a8', 'fa-viadeo': '\uf2a9',
    'fa-viadeo-square': '\uf2aa', 'fa-snapchat': '\uf2ab', 'fa-snapchat-ghost': '\uf2ac',
    'fa-snapchat-square': '\uf2ad', 'fa-pied-piper': '\uf2ae', 'fa-first-order': '\uf2b0',
    'fa-yoast': '\uf2b1', 'fa-themeisle': '\uf2b2', 'fa-google-plus-official': '\uf2b3',
    'fa-font-awesome': '\uf2b4', 'fa-handshake-o': '\uf2b5', 'fa-envelope-open': '\uf2b6',
    'fa-envelope-open-o': '\uf2b7', 'fa-linode': '\uf2b8', 'fa-address-book': '\uf2b9',
    'fa-address-book-o': '\uf2ba', 'fa-address-card': '\uf2bb', 'fa-address-card-o': '\uf2bc',
    'fa-user-circle': '\uf2bd', 'fa-user-circle-o': '\uf2be', 'fa-user-o': '\uf2c0',
    'fa-id-badge': '\uf2c1', 'fa-id-card': '\uf2c2', 'fa-id-card-o': '\uf2c3',
    'fa-quora': '\uf2c4', 'fa-free-code-camp': '\uf2c5', 'fa-telegram': '\uf2c6',
    'fa-thermometer-full': '\uf2c7', 'fa-thermometer-three-quarters': '\uf2c8', 'fa-thermometer-half': '\uf2c9',
    'fa-thermometer-quarter': '\uf2ca', 'fa-thermometer-empty': '\uf2cb', 'fa-shower': '\uf2cc',
    'fa-bath': '\uf2cd', 'fa-podcast': '\uf2ce', 'fa-window-maximize': '\uf2d0',
    'fa-window-minimize': '\uf2d1', 'fa-window-restore': '\uf2d2', 'fa-window-close': '\uf2d3',
    'fa-window-close-o': '\uf2d4', 'fa-bandcamp': '\uf2d5', 'fa-grav': '\uf2d6',
    'fa-etsy': '\uf2d7', 'fa-imdb': '\uf2d8', 'fa-ravelry': '\uf2d9',
    'fa-eercast': '\uf2da', 'fa-microchip': '\uf2db', 'fa-snowflake-o': '\uf2dc',
    'fa-superpowers': '\uf2dd', 'fa-wpexplorer': '\uf2de', 'fa-meetup': '\uf2e0'
  };
  function error(code, message) { return Object.assign(new Error(message), { code: code }); }
  function id(value) {
    if (typeof value !== 'string' || !/^app_[A-Za-z0-9_-]+$/.test(value)) throw error('INVALID_ADDRESS', '无效的应用 ID，必须使用 app_ 前缀');
    return value;
  }
  function slug(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw error('INVALID_ADDRESS', '应用别名必须为字符串');
    value = value.trim().toLowerCase();
    if (!value) return null;
    if (value.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw error('INVALID_ADDRESS', '应用别名限 1–64 位英文字母、数字和单个连接用的横线，如 my-tools');
    if (['source', 'capabilities', 'dependency'].includes(value)) throw error('INVALID_ADDRESS', '此地址为系统保留地址，请更换别名');
    return value;
  }
  function path(appId, slot, alias) { return '/apps/' + (slug(alias) || id(appId)) + (slot === 'draft' ? '/draft' : ''); }
  function parsePath(value) {
    var match = /^\/apps\/(app_[A-Za-z0-9_-]+)(\/draft)?$/.exec(value);
    if (match) return { appId: match[1], slot: match[2] ? 'draft' : 'published' };
    match = /^\/apps\/([A-Za-z0-9-]+)(\/draft)?$/.exec(value);
    if (!match) return null;
    try { return { slug: slug(match[1]), slot: match[2] ? 'draft' : 'published' }; } catch (_) { return null; }
  }
  function parseUrl(value, extensionUrl) {
    try {
      var url = new URL(value), extension = new URL(extensionUrl);
      if (url.protocol !== 'chrome-extension:' || url.protocol !== extension.protocol
          || url.host !== extension.host || url.search) return null;
      return parsePath(url.pathname);
    } catch (_) { return null; }
  }
  function launchHash(input) {
    var hash = '#page-agent-input=' + encodeURIComponent(json(input));
    if (hash.length > 16384) throw error('RESOURCE_BUSY', '应用启动参数编码后不能超过 16 KiB，请传入业务记录 ID');
    return hash;
  }
  function launchInput(hash) {
    if (!hash.startsWith('#page-agent-input=')) return null;
    if (hash.length > 16384) throw error('RESOURCE_BUSY', '应用启动参数编码后不能超过 16 KiB');
    try { return JSON.parse(decodeURIComponent(hash.slice('#page-agent-input='.length))); }
    catch (_) { throw error('INVALID_REQUEST', '无效的应用启动参数'); }
  }
  function normalizeName(value) { return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
  function revision() { return crypto.randomUUID(); }
  function sourceFileName(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(js|css)$/.test(name) || name.includes('..') || name === '__entry__.js') throw error('INVALID_ADDRESS', '应用源码文件名须为不含目录的 JS/CSS 文件名，__entry__.js 为保留名称');
    return name;
  }
  function sourceBase(appId, slot, revision) {
    return '/apps/source/' + appId + '/' + slot + '/' + revision + '/';
  }
  function resolveSourceFiles(source, base, files) {
    return source.replace(/app-file:([A-Za-z0-9_.-]+)/g, function (_, name) {
      sourceFileName(name);
      if (!Object.prototype.hasOwnProperty.call(files || {}, name)) throw error('RESOURCE_NOT_FOUND', '应用源码文件不存在: ' + name);
      return base + name;
    });
  }
  function json(value) {
    try {
      var ancestors = new Set();
      function check(item) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item)) throw new Error('数据必须为 JSON 值');
        if (item && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('数据必须使用普通 JSON 对象');
        if (!item || typeof item !== 'object') return;
        if (ancestors.has(item)) throw new Error('数据不能包含循环引用');
        ancestors.add(item);
        // Check before JSON.stringify can call toJSON or coerce array holes.
        var keys = Array.isArray(item) ? Array.from({ length: item.length }, function (_, index) { return String(index); }) : Object.keys(item);
        if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('数组不能包含稀疏项或额外字段');
        keys.forEach(function (key) {
          var descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error('数据不能包含稀疏数组或访问器');
          check(descriptor.value);
        });
        if (typeof item.toJSON === 'function' || Object.getOwnPropertySymbols(item).length) throw new Error('数据不能包含自定义序列化或 Symbol 字段');
        ancestors.delete(item);
      }
      check(value);
      return JSON.stringify(value);
    } catch (failure) { throw error('SERIALIZATION_FAILED', '数据无法序列化: ' + failure.message); }
  }
  var unsupportedNodes = Object.freeze(['runAssistant', 'setProxy', 'clearProxy', 'checkpointGet', 'checkpointSet', 'sendEmail', 'downloadMedia']);
  function assertNode(node) {
    if (unsupportedNodes.includes(node.type)) throw error('UNSUPPORTED_CAPABILITY', '应用 SDK 尚未开放节点 ' + node.type + ' 的授权范围；请调整绑定流程');
  }
  function object(properties, required) { return { type: 'object', properties: properties, required: required || [], additionalProperties: false }; }
  var parameterSchema = object({
    mode: { type: 'string', enum: ['form', 'module', 'none'] },
    description: { type: 'string', minLength: 1 },
    schema: { type: 'object' }, example: { type: 'object' },
    bindings: { type: 'object', additionalProperties: { type: 'string', minLength: 1 } },
    module: { type: 'string', pattern: '\\.js$' }
  }, ['mode', 'description', 'schema', 'example']);
  function noParameters() {
    return { mode: 'none', description: '无启动参数，不执行参数处理。', schema: object({}), example: {} };
  }
  function validateParameters(code, options) {
    var parameters = code.parameters ?? noParameters();
    var validation = root.AgentResourceProtocol.validateJsonSchema(parameterSchema, parameters);
    if (!validation.valid) throw error('SCHEMA_VALIDATION_FAILED', validation.errors.join('; '));
    if (!parameters.description.trim()) throw error('SCHEMA_VALIDATION_FAILED', '启动参数必须说明处理方式或无参数状态');
    var schema = parameters.schema, properties = schema.properties;
    if (schema.type !== 'object' || schema.additionalProperties !== false || !properties || typeof properties !== 'object' || Array.isArray(properties)) throw error('SCHEMA_VALIDATION_FAILED', '启动参数 schema 必须是声明 properties 且 additionalProperties=false 的 object');
    var names = Object.keys(properties);
    if (parameters.mode !== 'none' && !names.length) throw error('SCHEMA_VALIDATION_FAILED', '接收参数时须声明实际字段；无参数需求请使用 mode=none');
    names.forEach(function (name) {
      var field = properties[name];
      if (['__proto__', 'constructor', 'prototype'].includes(name) || !field || typeof field !== 'object' || Array.isArray(field) || typeof field.description !== 'string' || !field.description.trim()) throw error('SCHEMA_VALIDATION_FAILED', '启动参数须逐项说明用途：' + name);
    });
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(function (name) { return !names.includes(name); }))) throw error('SCHEMA_VALIDATION_FAILED', '启动参数 required 必须引用已声明字段');
    if (parameters.mode === 'form') {
      var bindings = parameters.bindings;
      if (parameters.module !== undefined || !bindings || Object.keys(bindings).length !== names.length || names.some(function (name) { return !Object.prototype.hasOwnProperty.call(bindings, name) || !['string', 'number', 'integer', 'boolean'].includes(properties[name].type); })) throw error('SCHEMA_VALIDATION_FAILED', '表单映射须为每个标量参数声明 bindings，值为控件 ID');
      if (new Set(Object.values(bindings)).size !== names.length) throw error('SCHEMA_VALIDATION_FAILED', '表单映射的控件 ID 不能重复');
    } else if (parameters.mode === 'module') {
      sourceFileName(parameters.module);
      if (parameters.bindings !== undefined || !parameters.module.endsWith('.js') || !Object.prototype.hasOwnProperty.call(code.files || {}, parameters.module) && !Object.prototype.hasOwnProperty.call(options && options.parameterFiles || {}, parameters.module)) throw error('SCHEMA_VALIDATION_FAILED', '模块适配须引用 code.files 中导出 applyParameters(input) 的 JS 文件');
    } else if (names.length || parameters.bindings !== undefined || parameters.module !== undefined) throw error('SCHEMA_VALIDATION_FAILED', '不接收参数时 schema.properties 必须为空，不声明 bindings 或 module');
    validation = root.AgentResourceProtocol.validateJsonSchema(schema, parameters.example);
    if (!validation.valid) throw error('SCHEMA_VALIDATION_FAILED', '启动参数示例不符合 schema：' + validation.errors.join('; '));
    launchHash(parameters.example);
    return parameters;
  }
  function validateLaunchInput(code, input) {
    if (input === undefined) return;
    launchHash(input);
    var parameters = validateParameters(code);
    var validation = root.AgentResourceProtocol.validateJsonSchema(parameters.schema, input);
    if (!validation.valid) throw error('SCHEMA_VALIDATION_FAILED', '启动参数不符合应用声明：' + validation.errors.join('; '));
  }
  var dependency = object({ uri: { type: 'string' }, fingerprint: { type: 'string' } }, ['uri', 'fingerprint']);
  var action = object({
    name: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_-]*$' }, purpose: { type: 'string' },
    resource: dependency, inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    context: { type: 'object' }, sideEffects: { type: 'array', items: { type: 'string' } },
    dependencies: { type: 'array', items: dependency }
  }, ['name', 'purpose', 'resource', 'inputSchema', 'outputSchema', 'sideEffects', 'targets']);
  action.properties.targets = object({
    origins: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    methods: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] } },
    pageIds: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    pageOperations: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    modelServiceIds: { type: 'array', uniqueItems: true, items: { type: 'string' } }
  }, ['origins', 'methods', 'pageIds', 'pageOperations', 'modelServiceIds']);
  var codeSchema = object({
    html: { type: 'string' }, css: { type: 'string' }, javascript: { type: 'string' }, themeCss: { type: 'string' },
    files: { type: 'object', additionalProperties: { type: 'string' }, description: '应用自有 JS/CSS 文件，键为不含目录的文件名，值为完整源码。JavaScript 用相对 import，HTML/CSS 用 app-file:文件名。随草稿、发布、复制和导出保存。' },
    description: { type: 'string' }, parameters: parameterSchema, customBehavior: { type: 'array', items: { type: 'string' } },
    networkPolicy: { type: 'string', enum: ['offline'] },
    capabilities: { type: 'array', uniqueItems: true, items: { type: 'string', enum: CAPABILITIES } },
    actions: { type: 'array', items: action }, dependencies: { type: 'array', items: dependency },
    externalResources: { type: 'array', items: object({ url: { type: 'string' }, purpose: { type: 'string' }, kind: { type: 'string', enum: ['image', 'font', 'css', 'script'] } }, ['url', 'purpose', 'kind']) }
  }, ['html', 'css', 'javascript', 'themeCss', 'description', 'capabilities', 'actions', 'dependencies', 'customBehavior', 'externalResources']);
  parameterSchema.description = '启动参数声明；省略时平台使用 mode=none 的空参数默认值，不执行参数处理。有业务参数时声明实际字段、示例与处理方式。';
  codeSchema.description = 'HTML、CSS、JavaScript、themeCss 和 files 保存可维护的源码：新建或重写时使用正常换行和缩进，不压成单行；局部修改沿用周围格式，不重排无关内容。保存按提交内容存储，不自动格式化。';
  function validateCode(code, scope, options) {
    var validation = root.AgentResourceProtocol.validateJsonSchema(codeSchema, code.parameters == null ? Object.assign({}, code, { parameters: noParameters() }) : code);
    if (!validation.valid) throw error('SCHEMA_VALIDATION_FAILED', validation.errors.join('; '));
    validateParameters(code, options);
    Object.keys(code.files || {}).forEach(sourceFileName);
    if (code.files) [code.html, code.css, code.themeCss].forEach(function (source) { resolveSourceFiles(source, '', code.files); });
    if (!Array.isArray(scope) || scope.some(function (item) { return CAPABILITIES.indexOf(item) === -1; })) throw error('SCHEMA_VALIDATION_FAILED', '应用能力范围包含 SDK 未提供的能力');
    // A disabled capability blocks execution; saving or publishing code must still work.
    var names = new Set();
    code.actions.forEach(function (item) {
      if (names.has(item.name)) throw error('SCHEMA_VALIDATION_FAILED', '动作名称重复: ' + item.name);
      names.add(item.name);
      item.targets.origins.forEach(function (origin) { var url; try { url = new URL(origin); } catch (_) {} if (!url || !/^https?:$/.test(url.protocol) || url.origin !== origin) throw error('SCHEMA_VALIDATION_FAILED', '动作目标必须为明确的 http/https origin: ' + origin); });
      if (!/^\/(flows|flow-groups|scripts)\/[^/?#]+$/.test(item.resource.uri)) throw error('UNSUPPORTED_CAPABILITY', '应用 SDK 只支持绑定 Flow、FlowGroup 或 Script 动作');
    });
    if (code.actions.length && code.capabilities.indexOf('actions.run') === -1) throw error('SCHEMA_VALIDATION_FAILED', '动作需要声明 actions.run');
    if (code.externalResources.some(function (item) { return item.kind === 'script'; })) throw error('UNSUPPORTED_CAPABILITY', 'MV3 应用宿主不支持远程 JavaScript；请保留需求并改用 SDK 动作');
    return code;
  }
  function declarations(code) {
    return code.capabilities.filter(function (item) { return item !== 'actions.run'; }).map(function (name) {
      return { name: name, purpose: name === 'data.read' ? '读取本应用数据' : name === 'data.write' ? '保存本应用数据' : '删除本应用数据', scope: 'self', fingerprint: '' };
    }).concat(code.actions.map(function (item) {
      return { name: 'action:' + item.name, purpose: item.purpose, scope: JSON.stringify({ resource: item.resource.uri, targets: item.targets }), targets: item.targets, fingerprint: item.resource.fingerprint, sideEffects: item.sideEffects };
    }));
  }
  function codeDependencies(code) {
    return (code.dependencies || []).concat((code.actions || []).flatMap(function (action) {
      return [action.resource].concat(action.dependencies || [], action.targets.pageIds.map(function (id) { return { uri: '/pages/' + encodeURIComponent(id), fingerprint: '' }; }), action.targets.modelServiceIds.map(function (id) { return { uri: '/model-services/' + encodeURIComponent(id), fingerprint: '' }; }));
    }));
  }
  function validateExecutionDependencies(code, resolved) {
    var bindings = new Map(code.dependencies.map(function (dependency) { return [dependency.uri, dependency.fingerprint]; }));
    codeDependencies(code).concat(resolved || []).forEach(function (dependency) {
      if (!bindings.get(dependency.uri) || dependency.fingerprint && bindings.get(dependency.uri) !== dependency.fingerprint) throw error('DEPENDENCY_UNRESOLVED', '应用缺少完整执行依赖，请重新保存或导入: ' + dependency.uri);
    });
  }
  function assetReferences(code) {
    var names = new Set();
    [code.html, code.css, code.themeCss].forEach(function (source) {
      for (var match of source.matchAll(/app-asset:([A-Za-z0-9_./-]+)/g)) names.add(match[1]);
    });
    // Only literal SDK arguments are statically known; computed names are checked on access.
    for (var match of code.javascript.matchAll(/\bPageAgent\s*\.\s*asset\s*\(\s*(['"`])([A-Za-z0-9_./-]+)\1\s*\)/g)) names.add(match[2]);
    return Array.from(names);
  }
  function validateAssets(code, slot, available) {
    var missing = assetReferences(code).filter(function (name) {
      return name.startsWith('/') || name.includes('..') || !available.has('theme/' + slot + '/' + name);
    });
    if (missing.length) throw error('RESOURCE_NOT_FOUND', slot + ' 源码引用的主题资源缺失或路径无效: ' + missing.join('、'));
  }
  function checkPermission(meta, permission, slot, name, auth) {
    if (!meta || !permission) throw error('SESSION_CLOSED', '应用已删除');
    var current = meta.slots[slot];
    if (!current) throw error('NOT_PUBLISHED', '应用尚未发布，请打开草稿预览');
    if (auth && current.revision !== auth.revision) throw error('CONTENT_CHANGED', '应用已更新，请加载新内容');
    if (auth && permission.generation !== auth.generation) throw error('AUTHORIZATION_CHANGED', '授权已变化，请刷新权限后操作');
    if (!permission.enabled) throw error('PERMISSION_DENIED', '用户已关闭 SDK 调用');
    var capability = name.indexOf('action:') === 0 ? 'actions.run' : name;
    if (!permission.generationScope.includes(capability)) throw error('PERMISSION_DENIED', '用户已关闭此应用能力: ' + capability);
    var declaration = current.declarations.find(function (item) { return item.name === name; });
    if (!declaration) throw error('PERMISSION_DENIED', '应用未声明此能力: ' + name);
    return declaration;
  }
  root.AppContract = Object.freeze({
    VERSION: VERSION, PORT: 'PAGE_AGENT_APP_V1', CAPABILITIES: Object.freeze(CAPABILITIES), ICONS: Object.freeze(ICONS),
    codeSchema: codeSchema, parameterSchema: parameterSchema, noParameters: noParameters, validateParameters: validateParameters, validateLaunchInput: validateLaunchInput,
    parameterGuidance: '应用统一通过 code.parameters 声明启动参数。生成源码时直接复用 /apps/capabilities 的 defaults.parameters：mode=none、空 properties 和 example；省略 input 或传 {} 均正常打开，不执行参数处理，非空参数被拒绝。旧应用缺少声明或值为 null 时也自动使用此默认值，读取和编辑直接展示默认对象，无需手动补齐即可保存、发布。仅按当前业务需要声明实际字段、说明、example 与处理方式，不为接入机制额外添加 query 等示例字段或控件。简单赋值可选 form，按 bindings 映射到真实控件 ID；需要联动时使用 module，指向 code.files 中导出 applyParameters(input) 的文件，宿主等待入口初始化完成后调用一次。模块示例见 /apps/capabilities；详细生成规则按需读取最新 builtin_app_generation_guide。调用方先 GET /apps/{appId} 查看 slots.published.parameters，不猜测参数；/open 成功只确认打开标签页，不证明参数处理或业务执行成功。',
    object: object, error: error, id: id, slug: slug, path: path, parsePath: parsePath, parseUrl: parseUrl, launchHash: launchHash, launchInput: launchInput,
    normalizeName: normalizeName, revision: revision, sourceFileName: sourceFileName, sourceBase: sourceBase, resolveSourceFiles: resolveSourceFiles, validateCode: validateCode, declarations: declarations, json: json,
    codeDependencies: codeDependencies, validateExecutionDependencies: validateExecutionDependencies,
    assetReferences: assetReferences, validateAssets: validateAssets,
    unsupportedNodes: unsupportedNodes, assertNode: assertNode,
    checkPermission: checkPermission,
    guidance: '创建、修改或修复应用前，读取 /apps 或目标应用资源；当前上下文缺少完整生成指引或已知指引更新时，完整 GET /knowledge/builtin_app_generation_guide，摘要或检索片段不能代替正文。同一对话复用已读指引，不因新一轮输入、继续或后台重启而重读。__builtin=true 的应用只读；编辑前带 If-Match 调用 POST /apps/{appId}/copy，后续修改返回的应用副本。内置应用声明的本地 JS/CSS 存入 code.files，复制、发布和导出携带原文；GET /apps/{appId}/{slot}/files 列出文件，GET /apps/{appId}/{slot}/files/{fileName} 按行读取或搜索，slot 为 draft 或 published，无需访问插件安装目录。局部源码修改优先 POST /apps/{appId}/draft/edits，body 为 {edits:[{field,oldText,newText}]}，文件编辑另带 fileName 且 field=files；只读和提交所需片段，携带最新应用 ETag 和幂等键，无需重传整段源码。',
    limits: Object.freeze({ recentApps: 5, nameLength: 32, messageBytes: 256 * 1024, inFlight: 8, requestsPerSecond: 30, timeoutMs: 60000 })
  });
})(globalThis);
