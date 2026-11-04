// Backend for the Promoter Track Sheet site. Saves each visit to a Google Sheet,
// its photos to a private Drive folder, and copies the original fields to the Google Form.
// Setup steps are in README.md.

var FORWARD_TO_GOOGLE_FORM = true;
var FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSeS1xZuvCCh9p5DCVAYNsBIsYAKNIp_8SxSNRNxF_qJZoHjWA/formResponse';
var FORM_ENTRIES = {
  garageName: 'entry.593615465',
  garageType: 'entry.624285119',
  mobile: 'entry.827047704',
  address: 'entry.346036907',
  monthlySales: 'entry.1270191770',
  suppliers: 'entry.1506219416',
  topGrades: 'entry.1354450455',
  displayBoard: 'entry.1717523560',
  servoAvailable: 'entry.515623223',
  needBoard: 'entry.817612585'
};

var TIME_ZONE = 'Asia/Kolkata';
var MAX_PHOTOS = 3;
var MAX_PHOTO_CHARS = 8 * 1000 * 1000;
var HEADERS = [
  'Visit ID', 'Visit Time', 'Received', 'Promoter', 'Reseller/Garage Name', 'Type of Garage',
  'Mobile Number', 'Address', 'Total Monthly Sales', 'Current Supplier Company',
  'High Selling Grade Names', 'Display Board by which Company', 'Servo Grades available',
  'Need Servo Display Board', 'Latitude', 'Longitude', 'GPS Accuracy (m)', 'Map Link',
  'Photo 1', 'Photo 2', 'Photo 3', 'Google Form Copy'
];
var FORM_STATUS_COLUMN = HEADERS.length;

// Run once from the editor to approve permissions and see the Sheet and folder links.
function setup() {
  var store = getStore_();
  Logger.log('Sheet: ' + store.sheet.getParent().getUrl());
  Logger.log('Photos folder: ' + store.folder.getUrl());
}

function doGet() {
  return json_({ ok: true, service: 'promoter-track-sheet' });
}

function doPost(e) {
  try {
    var visit = JSON.parse(e.postData.contents);
    var problem = validate_(visit);
    if (problem) return json_({ ok: false, error: problem });

    var store = getStore_();
    // A retry after a lost response must not create a second row.
    if (findVisit_(store.sheet, visit.id)) return json_({ ok: true, duplicate: true });

    var photoLinks = savePhotos_(store.folder, visit);

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var row;
    try {
      if (findVisit_(store.sheet, visit.id)) return json_({ ok: true, duplicate: true });
      store.sheet.appendRow(buildRow_(visit, photoLinks));
      row = store.sheet.getLastRow();
    } finally {
      lock.releaseLock();
    }

    store.sheet.getRange(row, FORM_STATUS_COLUMN).setValue(forwardToForm_(visit));
    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Server error. Will need to be sent again.' });
  }
}

function validate_(v) {
  if (!v || typeof v !== 'object') return 'Invalid visit.';
  if (!/^[\w-]{8,64}$/.test(String(v.id))) return 'Invalid visit ID.';
  var required = ['promoterName', 'garageName', 'garageType', 'address', 'monthlySales',
    'suppliers', 'topGrades', 'servoAvailable', 'needBoard'];
  for (var i = 0; i < required.length; i++) {
    if (!String(v[required[i]] || '').trim()) return 'Missing field: ' + required[i];
  }
  if (isNaN(new Date(v.createdAt).getTime())) return 'Invalid visit time.';
  if (v.lat !== null && !isCoordinate_(v.lat, 90)) return 'Invalid latitude.';
  if (v.lng !== null && !isCoordinate_(v.lng, 180)) return 'Invalid longitude.';
  var photos = v.photos || [];
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS) return 'Too many photos.';
  for (var p = 0; p < photos.length; p++) {
    var data = String(photos[p].dataUrl || '');
    if (data.indexOf('data:image/jpeg;base64,') !== 0 || data.length > MAX_PHOTO_CHARS) return 'Invalid photo.';
  }
  return '';
}

function isCoordinate_(value, limit) {
  return typeof value === 'number' && isFinite(value) && Math.abs(value) <= limit;
}

function getStore_() {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheetId = props.getProperty('SHEET_ID');
    var folderId = props.getProperty('FOLDER_ID');
    if (!sheetId) {
      var created = SpreadsheetApp.create('Promoter Track Sheet - Field Visits');
      var first = created.getSheets()[0];
      first.setName('Visits');
      first.appendRow(HEADERS);
      first.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#0b2a4a').setFontColor('#ffffff');
      first.setFrozenRows(1);
      first.hideColumns(1);
      sheetId = created.getId();
      props.setProperty('SHEET_ID', sheetId);
    }
    if (!folderId) {
      folderId = DriveApp.createFolder('Promoter Track Sheet - Photos').getId();
      props.setProperty('FOLDER_ID', folderId);
    }
    return {
      sheet: SpreadsheetApp.openById(sheetId).getSheetByName('Visits'),
      folder: DriveApp.getFolderById(folderId)
    };
  } finally {
    lock.releaseLock();
  }
}

function findVisit_(sheet, id) {
  var last = sheet.getLastRow();
  if (last < 2) return false;
  return !!sheet.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
}

function savePhotos_(folder, visit) {
  var stamp = Utilities.formatDate(new Date(visit.createdAt), TIME_ZONE, 'yyyy-MM-dd HHmm');
  return (visit.photos || []).map(function (photo, i) {
    var bytes = Utilities.base64Decode(photo.dataUrl.split(',')[1]);
    var name = [stamp, clean_(visit.garageName, 60), clean_(photo.label, 30) || 'Photo ' + (i + 1)].join(' - ') + '.jpg';
    return folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name)).getUrl();
  });
}

function buildRow_(v, photoLinks) {
  var hasFix = v.lat !== null && v.lng !== null;
  return [
    v.id,
    formatTime_(new Date(v.createdAt)),
    formatTime_(new Date()),
    text_(v.promoterName),
    text_(v.garageName),
    text_(garageTypeLabel_(v)),
    text_(v.mobile),
    text_(v.address),
    text_(v.monthlySales),
    text_(v.suppliers),
    text_(v.topGrades),
    text_(v.displayBoard),
    text_(v.servoAvailable),
    text_(v.needBoard),
    hasFix ? v.lat : '',
    hasFix ? v.lng : '',
    hasFix && typeof v.accuracy === 'number' ? v.accuracy : '',
    hasFix ? 'https://www.google.com/maps?q=' + v.lat + ',' + v.lng : 'Not captured',
    photoLinks[0] || '',
    photoLinks[1] || '',
    photoLinks[2] || '',
    FORWARD_TO_GOOGLE_FORM ? 'Pending' : 'Off'
  ];
}

function forwardToForm_(v) {
  if (!FORWARD_TO_GOOGLE_FORM) return 'Off';
  try {
    var payload = {};
    ['garageName', 'mobile', 'address', 'monthlySales', 'suppliers', 'topGrades', 'displayBoard',
      'servoAvailable', 'needBoard'].forEach(function (key) {
      payload[FORM_ENTRIES[key]] = String(v[key] || '');
    });
    if (v.garageType === 'Other') {
      payload[FORM_ENTRIES.garageType] = '__other_option__';
      payload[FORM_ENTRIES.garageType + '.other_option_response'] = String(v.garageTypeOther || '');
    } else {
      payload[FORM_ENTRIES.garageType] = String(v.garageType);
    }
    var res = UrlFetchApp.fetch(FORM_URL, { method: 'post', payload: payload, muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? 'Sent' : 'Failed (' + res.getResponseCode() + ')';
  } catch (err) {
    console.error(err);
    return 'Failed';
  }
}

function garageTypeLabel_(v) {
  return v.garageType === 'Other' ? 'Other: ' + (v.garageTypeOther || '') : v.garageType;
}

function formatTime_(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'dd-MMM-yyyy HH:mm:ss');
}

// Stored as plain text so a value such as "=SUM(...)" or "+9198..." is never run as a formula.
function text_(value) {
  var s = String(value === null || value === undefined ? '' : value).slice(0, 2000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function clean_(value, max) {
  return String(value || '').replace(/[^\w .-]+/g, ' ').trim().slice(0, max);
}

function json_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
