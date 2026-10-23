require('dotenv').config();

const dns = require('node:dns');
const net = require('node:net');
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const { randomUUID } = require('crypto');
const Student = require('./models/Student');
const LostItem = require('./models/LostItem');
const FoundItem = require('./models/FoundItem');
const Claim = require('./models/Claim');

const app = express();
const port = Number(process.env.PORT) || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanFormValues(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.trim() : ''
    ])
  );
}

function validateRequired(values, fields) {
  return fields
    .filter((field) => !values[field])
    .map((field) => `${field[0].toUpperCase()}${field.slice(1)} is required.`);
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validationMessages(error) {
  if (error.name === 'ValidationError') {
    return Object.values(error.errors).map((entry) => entry.message);
  }
  return ['Please check the submitted information and try again.'];
}

async function studentsForForm() {
  return Student.find().sort({ fullName: 1 }).select('fullName email');
}

function renderItemForm(res, kind, { values = {}, errors = [], students = [], status = 200 } = {}) {
  return res.status(status).render(`report-${kind}-item`, {
    title: `Report a ${kind} item`,
    values,
    errors,
    students
  });
}

function renderNotFound(res, message = 'The page or record you requested could not be found.') {
  return res.status(404).render('404', { title: 'Page not found', message });
}

function renderFoundItemDetails(res, item, options = {}) {
  return res.status(options.status || 200).render('found-item-details', {
    title: item.itemName,
    item,
    students: options.students || [],
    claimValues: options.claimValues || {},
    claimErrors: options.claimErrors || [],
    notice: options.notice || ''
  });
}

function renderDecisionError(res, status, message) {
  return res.status(status).render('error', {
    title: 'Claim decision could not be completed',
    message
  });
}

function mongoConnectionTarget(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGODB_URI is not a valid MongoDB connection string.');
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('MONGODB_URI must use mongodb:// or mongodb+srv://.');
  }

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    databaseName: decodeURIComponent(parsed.pathname.slice(1).split('/')[0] || '')
  };
}

function mongoDnsServers() {
  const configured = process.env.MONGODB_DNS_SERVERS;
  const servers = configured
    ? configured.split(',').map((server) => server.trim()).filter(Boolean)
    : ['8.8.8.8', '8.8.4.4'];
  if (!servers.length || servers.some((server) => !net.isIP(server))) {
    throw new Error('MONGODB_DNS_SERVERS must contain comma-separated DNS server IP addresses.');
  }
  return servers;
}

function safeMongoConnectionError(error) {
  if (error.code === 18) {
    return 'MongoDB authentication failed. Check the Atlas database user credentials in .env.';
  }
  if (error.name === 'MongoParseError') {
    return 'MONGODB_URI could not be parsed. Check its scheme, hostname, and database name.';
  }
  if (error.name === 'MongoServerSelectionError') {
    return 'MongoDB could not be reached. Check network access, VPN/firewall settings, and the Atlas IP access list.';
  }
  return `MongoDB connection failed (${error.name || 'unknown error'}${error.code ? `, code ${error.code}` : ''}).`;
}

class ClaimDecisionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function transactionUnsupported(error) {
  return error.code === 20 &&
    /transaction numbers are only allowed/i.test(error.message || '');
}

async function approveClaimInTransaction(claimId, ownerId, returnToken) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const claim = await Claim.findById(claimId).session(session);
      if (!claim) throw new ClaimDecisionError(404, 'No claim was found with that ID.');
      if (claim.status !== 'Pending') {
        throw new ClaimDecisionError(409, 'This claim has already been processed.');
      }

      const item = await FoundItem.findById(claim.foundItem).session(session);
      if (!item) throw new ClaimDecisionError(404, 'The found item for this claim no longer exists.');
      if (String(item.reportedBy) !== String(ownerId)) {
        throw new ClaimDecisionError(403, 'Only the student who reported this item may decide its claims.');
      }
      if (item.status !== 'Open') {
        throw new ClaimDecisionError(409, 'This found item is no longer available to be returned.');
      }

      const itemUpdate = await FoundItem.updateOne(
        { _id: item._id, reportedBy: ownerId, status: 'Open' },
        { $set: { status: 'Returned', returnedClaim: claim._id, returnToken } },
        { session }
      );
      if (itemUpdate.modifiedCount !== 1) {
        throw new ClaimDecisionError(409, 'This found item is no longer available to be returned.');
      }

      const claimUpdate = await Claim.updateOne(
        { _id: claim._id, status: 'Pending' },
        { $set: { status: 'Approved' } },
        { session }
      );
      if (claimUpdate.modifiedCount !== 1) {
        throw new ClaimDecisionError(409, 'This claim has already been processed.');
      }
    });
  } finally {
    await session.endSession();
  }
}

async function approveClaimWithCompensation(claimId, ownerId, returnToken) {
  const claim = await Claim.findById(claimId);
  if (!claim) throw new ClaimDecisionError(404, 'No claim was found with that ID.');
  if (claim.status !== 'Pending') {
    throw new ClaimDecisionError(409, 'This claim has already been processed.');
  }
  const item = await FoundItem.findById(claim.foundItem);
  if (!item) throw new ClaimDecisionError(404, 'The found item for this claim no longer exists.');
  if (String(item.reportedBy) !== String(ownerId)) {
    throw new ClaimDecisionError(403, 'Only the student who reported this item may decide its claims.');
  }
  if (item.status !== 'Open') {
    throw new ClaimDecisionError(409, 'This found item is no longer available to be returned.');
  }

  try {
    const reservedItem = await FoundItem.findOneAndUpdate(
      { _id: item._id, reportedBy: ownerId, status: 'Open' },
      { $set: { status: 'Returned', returnedClaim: claim._id, returnToken } },
      { new: true }
    );
    if (!reservedItem) {
      throw new ClaimDecisionError(409, 'This found item is no longer available to be returned.');
    }

    const claimUpdate = await Claim.updateOne(
      { _id: claim._id, status: 'Pending' },
      { $set: { status: 'Approved' } }
    );
    if (claimUpdate.modifiedCount !== 1) {
      throw new ClaimDecisionError(409, 'This claim has already been processed.');
    }
  } catch (error) {
    try {
      const latestClaim = await Claim.findById(claim._id).select('status');
      if (!latestClaim || latestClaim.status !== 'Approved') {
        const rollback = await FoundItem.updateOne(
          {
            _id: item._id,
            reportedBy: ownerId,
            status: 'Returned',
            returnedClaim: claim._id,
            returnToken
          },
          {
            $set: { status: 'Open' },
            $unset: { returnedClaim: 1, returnToken: 1 }
          }
        );
        if (rollback.modifiedCount !== 1 &&
            await FoundItem.exists({ _id: item._id, returnedClaim: claim._id, returnToken })) {
          console.error('Claim approval compensation did not restore the found item.');
        }
      }
    } catch (rollbackError) {
      console.error('Claim approval compensation failed:', rollbackError);
    }
    throw error;
  }
}

async function approveClaim(claimId, ownerId) {
  const returnToken = randomUUID();
  try {
    return await approveClaimInTransaction(claimId, ownerId, returnToken);
  } catch (error) {
    if (!transactionUnsupported(error)) throw error;
    return approveClaimWithCompensation(claimId, ownerId, returnToken);
  }
}

app.get('/', async (req, res, next) => {
  try {
    const [lostCount, foundCount, recentLost, recentFound] = await Promise.all([
      LostItem.countDocuments(),
      FoundItem.countDocuments(),
      LostItem.find().sort({ createdAt: -1 }).limit(3).populate('reportedBy', 'fullName'),
      FoundItem.find().sort({ createdAt: -1 }).limit(3).populate('reportedBy', 'fullName')
    ]);
    res.render('home', {
      title: 'Campus Lost & Found',
      lostCount,
      foundCount,
      recentLost,
      recentFound
    });
  } catch (error) {
    next(error);
  }
});

app.get('/students/new', (req, res) => {
  res.render('register-student', {
    title: 'Register student',
    values: {},
    errors: []
  });
});

app.post('/students', async (req, res, next) => {
  const values = cleanFormValues(req.body);
  const errors = validateRequired(values, ['fullName', 'email', 'department', 'contactNumber']);
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.push('Enter a valid email address.');
  }
  if (errors.length) {
    return res.status(400).render('register-student', {
      title: 'Register student',
      values,
      errors
    });
  }

  try {
    const student = await Student.create(values);
    return res.redirect(`/students/${student._id}`);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).render('register-student', {
        title: 'Register student',
        values,
        errors: ['A student with this email address is already registered.']
      });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).render('register-student', {
        title: 'Register student',
        values,
        errors: validationMessages(error)
      });
    }
    return next(error);
  }
});

app.get('/students/:id', async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return renderNotFound(res, 'That student ID is not valid.');
  }
  try {
    const student = await Student.findById(req.params.id);
    if (!student) return renderNotFound(res, 'No student was found with that ID.');
    return res.render('student-profile', { title: student.fullName, student });
  } catch (error) {
    return next(error);
  }
});

app.get('/lost-items/new', async (req, res, next) => {
  try {
    const students = await studentsForForm();
    return renderItemForm(res, 'lost', { students });
  } catch (error) {
    return next(error);
  }
});

app.post('/lost-items', async (req, res, next) => {
  const values = cleanFormValues(req.body);
  const errors = validateRequired(values, [
    'itemName',
    'category',
    'description',
    'lastSeenLocation',
    'dateLost',
    'reportedBy'
  ]);
  if (values.dateLost && !validDate(values.dateLost)) {
    errors.push('Enter a valid date lost.');
  }
  let students;
  try {
    students = await studentsForForm();
    if (values.reportedBy && !mongoose.isValidObjectId(values.reportedBy)) {
      errors.push('Select a valid reporting student.');
    } else if (values.reportedBy && !(await Student.exists({ _id: values.reportedBy }))) {
      errors.push('The selected reporting student does not exist.');
    }
    if (errors.length) {
      return renderItemForm(res, 'lost', { values, errors, students, status: 400 });
    }
    const item = await LostItem.create({
      ...values,
      dateLost: new Date(`${values.dateLost}T00:00:00.000Z`)
    });
    return res.redirect(`/lost-items/${item._id}`);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return renderItemForm(res, 'lost', {
        values,
        errors: validationMessages(error),
        students,
        status: 400
      });
    }
    return next(error);
  }
});

app.get('/lost-items', async (req, res, next) => {
  const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const filter = search
    ? {
        $or: ['itemName', 'category', 'lastSeenLocation'].map((field) => ({
          [field]: { $regex: escapeRegex(search), $options: 'i' }
        }))
      }
    : {};
  try {
    const items = await LostItem.find(filter)
      .sort({ createdAt: -1 })
      .populate('reportedBy', 'fullName email');
    return res.render('lost-items', {
      title: 'Lost items',
      items,
      search
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/lost-items/:id', async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return renderNotFound(res, 'That lost-item ID is not valid.');
  }
  try {
    const item = await LostItem.findById(req.params.id).populate(
      'reportedBy',
      'fullName email department contactNumber'
    );
    if (!item) return renderNotFound(res, 'No lost item was found with that ID.');
    return res.render('lost-item-details', { title: item.itemName, item });
  } catch (error) {
    return next(error);
  }
});

app.get('/found-items/new', async (req, res, next) => {
  try {
    const students = await studentsForForm();
    return renderItemForm(res, 'found', { students });
  } catch (error) {
    return next(error);
  }
});

app.post('/found-items', async (req, res, next) => {
  const values = cleanFormValues(req.body);
  const errors = validateRequired(values, [
    'itemName',
    'category',
    'description',
    'foundLocation',
    'dateFound',
    'reportedBy'
  ]);
  if (values.dateFound && !validDate(values.dateFound)) {
    errors.push('Enter a valid date found.');
  }
  let students;
  try {
    students = await studentsForForm();
    if (values.reportedBy && !mongoose.isValidObjectId(values.reportedBy)) {
      errors.push('Select a valid reporting student.');
    } else if (values.reportedBy && !(await Student.exists({ _id: values.reportedBy }))) {
      errors.push('The selected reporting student does not exist.');
    }
    if (errors.length) {
      return renderItemForm(res, 'found', { values, errors, students, status: 400 });
    }
    const item = await FoundItem.create({
      itemName: values.itemName,
      category: values.category,
      description: values.description,
      foundLocation: values.foundLocation,
      dateFound: new Date(`${values.dateFound}T00:00:00.000Z`),
      reportedBy: values.reportedBy
    });
    return res.redirect(`/found-items/${item._id}`);
  } catch (error) {
    if (error.name === 'ValidationError') {
      return renderItemForm(res, 'found', {
        values,
        errors: validationMessages(error),
        students,
        status: 400
      });
    }
    return next(error);
  }
});

app.get('/found-items', async (req, res, next) => {
  try {
    const items = await FoundItem.find()
      .sort({ createdAt: -1 })
      .populate('reportedBy', 'fullName email');
    return res.render('found-items', { title: 'Found items', items });
  } catch (error) {
    return next(error);
  }
});

app.get('/found-items/:id', async (req, res, next) => {
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return renderNotFound(res, 'That found-item ID is not valid.');
  }
  try {
    const [item, students] = await Promise.all([
      FoundItem.findById(req.params.id).populate(
        'reportedBy',
        'fullName email department contactNumber'
      ),
      studentsForForm()
    ]);
    if (!item) return renderNotFound(res, 'No found item was found with that ID.');
    const notice = req.query.notice === 'claim-submitted' ? 'Your claim was submitted for review.' : '';
    return renderFoundItemDetails(res, item, { students, notice });
  } catch (error) {
    return next(error);
  }
});

app.post('/found-items/:id/claims', async (req, res, next) => {
  const values = cleanFormValues(req.body);
  const errors = validateRequired(values, ['student', 'description']);
  if (values.description && values.description.length < 10) {
    errors.push('Please provide at least 10 characters of claim proof.');
  }
  if (values.description && values.description.length > 2000) {
    errors.push('Claim proof cannot exceed 2000 characters.');
  }
  if (!mongoose.isObjectIdOrHexString(req.params.id)) {
    return renderNotFound(res, 'That found-item ID is not valid.');
  }
  if (values.student && !mongoose.isObjectIdOrHexString(values.student)) {
    errors.push('Select a valid student.');
  }

  try {
    const [item, students] = await Promise.all([
      FoundItem.findById(req.params.id).populate(
        'reportedBy',
        'fullName email department contactNumber'
      ),
      studentsForForm()
    ]);
    if (!item) return renderNotFound(res, 'No found item was found with that ID.');
    if (values.student && mongoose.isObjectIdOrHexString(values.student) &&
        !(await Student.exists({ _id: values.student }))) {
      errors.push('The selected student does not exist.');
    }
    if (item.status === 'Returned') {
      errors.push('This item has already been returned and cannot receive new claims.');
    } else if (item.status !== 'Open') {
      errors.push('This item is not currently available for claims.');
    }
    if (errors.length) {
      return renderFoundItemDetails(res, item, {
        students,
        claimValues: values,
        claimErrors: errors,
        status: 400
      });
    }

    await Claim.create({
      student: values.student,
      foundItem: item._id,
      description: values.description
    });
    return res.redirect(`/found-items/${item._id}?notice=claim-submitted`);
  } catch (error) {
    if (error.code === 11000) {
      try {
        const [item, students] = await Promise.all([
          FoundItem.findById(req.params.id).populate(
            'reportedBy',
            'fullName email department contactNumber'
          ),
          studentsForForm()
        ]);
        if (!item) return renderNotFound(res, 'No found item was found with that ID.');
        return renderFoundItemDetails(res, item, {
          students,
          claimValues: values,
          claimErrors: ['You already have a pending claim for this item.'],
          status: 409
        });
      } catch (renderError) {
        return next(renderError);
      }
    }
    if (error.name === 'ValidationError') {
      try {
        const [item, students] = await Promise.all([
          FoundItem.findById(req.params.id).populate(
            'reportedBy',
            'fullName email department contactNumber'
          ),
          studentsForForm()
        ]);
        if (!item) return renderNotFound(res, 'No found item was found with that ID.');
        return renderFoundItemDetails(res, item, {
          students,
          claimValues: values,
          claimErrors: validationMessages(error),
          status: 400
        });
      } catch (renderError) {
        return next(renderError);
      }
    }
    return next(error);
  }
});

app.get('/claims/manage', async (req, res, next) => {
  const selectedStudentId = typeof req.query.studentId === 'string' ? req.query.studentId : '';
  const notices = {
    approved: 'The claim was approved and the item is marked as returned.',
    rejected: 'The claim was rejected. The item remains available for claims.'
  };
  try {
    const students = await studentsForForm();
    let selectedStudent = null;
    let claims = [];
    if (selectedStudentId) {
      if (!mongoose.isObjectIdOrHexString(selectedStudentId)) {
        return res.status(400).render('manage-claims', {
          title: 'Manage claims',
          students,
          selectedStudent: null,
          claims,
          notice: '',
          errors: ['Select a valid student to manage claims.']
        });
      }
      selectedStudent = await Student.findById(selectedStudentId).select('fullName email');
      if (!selectedStudent) return renderNotFound(res, 'No student was found with that ID.');
      const ownedItems = await FoundItem.find({ reportedBy: selectedStudent._id }).select('_id');
      if (ownedItems.length) {
        claims = await Claim.find({ foundItem: { $in: ownedItems.map((item) => item._id) } })
          .sort({ createdAt: -1 })
          .populate('student', 'fullName email department contactNumber')
          .populate('foundItem', 'itemName status reportedBy');
      }
    }
    return res.render('manage-claims', {
      title: 'Manage claims',
      students,
      selectedStudent,
      claims,
      notice: typeof req.query.notice === 'string' &&
        Object.prototype.hasOwnProperty.call(notices, req.query.notice)
        ? notices[req.query.notice]
        : '',
      errors: []
    });
  } catch (error) {
    return next(error);
  }
});

async function decideClaim(req, res, decision) {
  const claimId = req.params.id;
  const ownerId = typeof req.body.ownerStudentId === 'string' ? req.body.ownerStudentId.trim() : '';
  if (!mongoose.isObjectIdOrHexString(claimId) || !mongoose.isObjectIdOrHexString(ownerId)) {
    return renderDecisionError(res, 400, 'A valid claim and owner student ID are required.');
  }

  try {
    const ownerExists = await Student.exists({ _id: ownerId });
    if (!ownerExists) return renderDecisionError(res, 404, 'The selected owner student does not exist.');

    if (decision === 'approve') {
      await approveClaim(claimId, ownerId);
    } else {
      const claim = await Claim.findById(claimId);
      if (!claim) return renderDecisionError(res, 404, 'No claim was found with that ID.');
      const item = await FoundItem.findById(claim.foundItem);
      if (!item) return renderDecisionError(res, 404, 'The found item for this claim no longer exists.');
      if (String(item.reportedBy) !== String(ownerId)) {
        return renderDecisionError(res, 403, 'Only the student who reported this item may decide its claims.');
      }
      if (claim.status !== 'Pending') {
        return renderDecisionError(res, 409, 'This claim has already been processed.');
      }
      const result = await Claim.updateOne(
        { _id: claim._id, status: 'Pending' },
        { $set: { status: 'Rejected' } }
      );
      if (result.modifiedCount !== 1) {
        return renderDecisionError(res, 409, 'This claim has already been processed.');
      }
    }
    return res.redirect(`/claims/manage?studentId=${ownerId}&notice=${decision === 'approve' ? 'approved' : 'rejected'}`);
  } catch (error) {
    if (error instanceof ClaimDecisionError) {
      return renderDecisionError(res, error.status, error.message);
    }
    console.error('Claim decision failed:', error);
    return res.status(500).render('error', {
      title: 'Claim decision could not be completed',
      message: 'We could not complete that claim decision. Please try again later.'
    });
  }
}

app.post('/claims/:id/approve', (req, res) => decideClaim(req, res, 'approve'));
app.post('/claims/:id/reject', (req, res) => decideClaim(req, res, 'reject'));

app.use((req, res) => renderNotFound(res));

app.use((error, req, res, next) => {
  console.error('Request failed:', error);
  if (res.headersSent) return next(error);
  return res.status(500).render('error', {
    title: 'Something went wrong',
    message: 'We could not complete that request. Please try again later.'
  });
});

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing. Add it to your .env file before starting the server.');
  }

  const target = mongoConnectionTarget(process.env.MONGODB_URI);
  if (!target.hostname) {
    throw new Error('MONGODB_URI must include a MongoDB hostname.');
  }
  console.log(
    `Connecting to MongoDB host ${target.hostname}; database ${target.databaseName || '(default)'}.`
  );

  if (target.protocol === 'mongodb+srv:') {
    const servers = mongoDnsServers();
    dns.setServers(servers);
    try {
      const [srvRecords] = await Promise.all([
        dns.promises.resolveSrv(`_mongodb._tcp.${target.hostname}`),
        dns.promises.resolveTxt(target.hostname)
      ]);
      if (!srvRecords.length) throw new Error('No SRV records were returned.');
      console.log(`MongoDB Atlas SRV lookup succeeded using ${servers.join(', ')}.`);
    } catch (error) {
      throw new Error(
        `MongoDB Atlas DNS lookup failed for ${target.hostname} (${error.code || 'lookup error'}). ` +
        'Check DNS/network access or set MONGODB_DNS_SERVERS to reachable DNS server IPs.'
      );
    }
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
  } catch (error) {
    throw new Error(safeMongoConnectionError(error));
  }
  await Claim.init();
  app.listen(port, () => {
    console.log(`Campus Lost & Found is running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Unable to start the application: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = app;
