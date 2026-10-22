require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Student = require('./models/Student');
const LostItem = require('./models/LostItem');
const FoundItem = require('./models/FoundItem');

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
      ...values,
      dateFound: new Date(`${values.dateFound}T00:00:00.000Z`)
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
  if (!mongoose.isValidObjectId(req.params.id)) {
    return renderNotFound(res, 'That found-item ID is not valid.');
  }
  try {
    const item = await FoundItem.findById(req.params.id).populate(
      'reportedBy',
      'fullName email department contactNumber'
    );
    if (!item) return renderNotFound(res, 'No found item was found with that ID.');
    return res.render('found-item-details', { title: item.itemName, item });
  } catch (error) {
    return next(error);
  }
});

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
  await mongoose.connect(process.env.MONGODB_URI);
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
