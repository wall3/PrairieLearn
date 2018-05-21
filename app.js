const ERR = require('async-stacktrace');
const path = require('path');
const favicon = require('serve-favicon');
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const onFinished = require('on-finished');
const uuidv4 = require('uuid/v4');

const load = require('./lib/load');
const logger = require('./lib/logger');

module.exports = function(config) {
    const app = express();
    app.set('views', path.join(__dirname, 'pages'));
    app.set('view engine', 'ejs');

    config.devMode = (app.get('env') == 'development');

    app.use(function(req, res, next) {res.locals.homeUrl = config.homeUrl; next();});
    app.use(function(req, res, next) {res.locals.urlPrefix = res.locals.plainUrlPrefix = config.urlPrefix; next();});
    app.use(function(req, res, next) {res.locals.navbarType = 'plain'; next();});
    app.use(function(req, res, next) {res.locals.devMode = config.devMode; next();});
    app.use(function(req, res, next) {res.locals.is_administrator = false; next();});

    if (!config.devMode) {
        var OIDCStrategy = require('passport-azure-ad').OIDCStrategy;
        const azureConfig = {
            identityMetadata: config.azureIdentityMetadata,
            clientID: config.azureClientID,
            responseType: config.azureResponseType,
            responseMode: config.azureResponseMode,
            redirectUrl: config.azureRedirectUrl,
            allowHttpForRedirectUrl: config.azureAllowHttpForRedirectUrl,
            clientSecret: config.azureClientSecret,
            validateIssuer: config.azureValidateIssuer,
            isB2C: config.azureIsB2C,
            issuer: config.azureIssuer,
            passReqToCallback: config.azurePassReqToCallback,
            scope: config.azureScope,
            loggingLevel: config.azureLoggingLevel,
            nonceLifetime: config.azureNonceLifetime,
            nonceMaxAmount: config.azureNonceMaxAmount,
            useCookieInsteadOfSession: config.azureUseCookieInsteadOfSession,
            cookieEncryptionKeys: config.azureCookieEncryptionKeys,
            clockSkew: config.azureClockSkew,
        };
        passport.use(new OIDCStrategy(azureConfig, function(iss, sub, profile, accessToken, refreshToken, done) {return done(null, profile);}));
    }

    app.use(bodyParser.json({limit: 200 * 1024}));
    app.use(bodyParser.urlencoded({extended: false, limit: 200 * 1024}));
    app.use(cookieParser());
    app.use(passport.initialize());
    app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));

    if ('localRootFilesDir' in config) {
        logger.info(`localRootFilesDir: Mapping ${config.localRootFilesDir} into /`);
        app.use(express.static(config.localRootFilesDir));
    }
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/MathJax', express.static(path.join(__dirname, 'node_modules', 'mathjax')));
    app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

    // Middleware for all requests
    // response_id is logged on request, response, and error to link them together
    app.use(function(req, res, next) {res.locals.response_id = uuidv4(); next();});
    app.use(function(req, res, next) {res.locals.config = config; next();});

    // load accounting for requests
    app.use(function(req, res, next) {load.startJob('request', res.locals.response_id); next();});
    app.use(function(req, res, next) {
        onFinished(res, function (err, res) {
            if (ERR(err, () => {})) logger.verbose('on-request-finished error', {err});
            load.endJob('request', res.locals.response_id);
        });
        next();
    });

    // More middlewares
    app.use(require('./middlewares/logResponse')); // defers to end of response
    app.use(require('./middlewares/cors'));
    app.use(require('./middlewares/date'));
    app.use('/pl/oauth2login', require('./pages/authLoginOAuth2/authLoginOAuth2'));
    app.use('/pl/oauth2callback', require('./pages/authCallbackOAuth2/authCallbackOAuth2'));
    app.use('/pl/shibcallback', require('./pages/authCallbackShib/authCallbackShib'));
    app.use('/pl/azure_login', require('./pages/authLoginAzure/authLoginAzure'));
    app.use('/pl/azure_callback', require('./pages/authCallbackAzure/authCallbackAzure'));
    app.use('/pl/login', require('./pages/authLogin/authLogin'));
    // disable SEB until we can fix the mcrypt issues
    //app.use('/pl/downloadSEBConfig', require('./pages/studentSEBConfig/studentSEBConfig'));
    app.use(require('./middlewares/authn')); // authentication, set res.locals.authn_user
    app.use(require('./middlewares/csrfToken')); // sets and checks res.locals.__csrf_token
    app.use(require('./middlewares/logRequest'));

    // load accounting for authenticated accesses
    app.use(function(req, res, next) {load.startJob('authed_request', res.locals.response_id); next();});
    app.use(function(req, res, next) {
        onFinished(res, function (err, res) {
            if (ERR(err, () => {})) logger.verbose('on-request-finished error', {err});
            load.endJob('authed_request', res.locals.response_id);
        });
        next();
    });

    // clear all cached course code in dev mode (no authorization needed)
    if (config.devMode) {
        app.use(require('./middlewares/undefCourseCode'));
    }

    // clear cookies on the homepage to reset any stale session state
    app.use(/^\/pl\/?/, require('./middlewares/clearCookies'));

    // some pages don't need authorization
    app.use('/', require('./pages/home/home'));
    app.use('/pl', require('./pages/home/home'));
    app.use('/pl/enroll', require('./pages/enroll/enroll'));
    app.use('/pl/logout', require('./pages/authLogout/authLogout'));

    // dev-mode pages are mounted for both out-of-course access (here) and within-course access (see below)
    if (config.devMode) {
        app.use('/pl/loadFromDisk', require('./pages/instructorLoadFromDisk/instructorLoadFromDisk'));
        app.use('/pl/jobSequence', require('./pages/instructorJobSequence/instructorJobSequence'));
    }

    // all pages under /pl/course_instance require authorization
    app.use('/pl/course_instance/:course_instance_id', require('./middlewares/authzCourseInstance')); // sets res.locals.course and res.locals.courseInstance
    app.use('/pl/course_instance/:course_instance_id', function(req, res, next) {res.locals.urlPrefix = '/pl/course_instance/' + req.params.course_instance_id; next();});
    app.use('/pl/course_instance/:course_instance_id', function(req, res, next) {res.locals.navbarType = 'student'; next();});

    // Redirect plain course page to Instructor or Student assessments page.
    // We have to do this after initial authz so we know whether we are an Instructor,
    // but before instructor authz so we still get a chance to enforce that.
    app.use(/^\/pl\/course_instance\/[0-9]+\/?$/, function(req, res, _next) {
        if (res.locals.authz_data.has_instructor_view) {
            res.redirect(res.locals.urlPrefix + '/instructor/assessments');
        } else {
            res.redirect(res.locals.urlPrefix + '/assessments');
        }
    });

    // Redirect Instructor effectiveUser page to the Student version if we don't have Instructor authz.
    // This is needed to handle the redirection after we change effective user to a student.
    app.use(/^\/pl\/course_instance\/[0-9]+\/instructor\/effectiveUser(\/?.*)$/, function(req, res, next) {
        if (!res.locals.authz_data.has_instructor_view) {
            res.redirect(res.locals.urlPrefix + '/effectiveUser');
        } else {
            next();
        }
    });

    // all pages under /pl/course_instance/*/instructor require instructor permissions
    app.use('/pl/course_instance/:course_instance_id/instructor', require('./middlewares/authzCourseInstanceHasInstructorView'));
    app.use('/pl/course_instance/:course_instance_id/instructor', function(req, res, next) {res.locals.urlPrefix = '/pl/course_instance/' + req.params.course_instance_id + '/instructor'; next();});
    app.use('/pl/course_instance/:course_instance_id/instructor', function(req, res, next) {res.locals.navbarType = 'instructor'; next();});
    app.use('/pl/course_instance/:course_instance_id/instructor', require('./middlewares/selectOpenIssueCount'));

    // Serve element statics
    app.use('/pl/static/elements', require('./pages/elementFiles/elementFiles'));
    app.use('/pl/course_instance/:course_instance_id/elements', require('./pages/elementFiles/elementFiles'));

    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    // Instructor pages //////////////////////////////////////////////////

    app.use('/pl/course_instance/:course_instance_id/instructor/effectiveUser', [
        require('./pages/instructorEffectiveUser/instructorEffectiveUser'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/assessments', [
        require('./pages/instructorAssessments/instructorAssessments'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/assessment/:assessment_id', [
        require('./middlewares/selectAndAuthzAssessment'),
        require('./pages/shared/assessmentStatDescriptions'),
        require('./pages/shared/floatFormatters'),
        require('./pages/instructorAssessment/instructorAssessment'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/assessment_instance/:assessment_instance_id', [
        require('./middlewares/selectAndAuthzAssessmentInstance'),
        require('./pages/shared/floatFormatters'),
        require('./pages/instructorAssessmentInstance/instructorAssessmentInstance'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/question/:question_id', [
        require('./middlewares/selectAndAuthzInstructorQuestion'),
        require('./pages/shared/assessmentStatDescriptions'),
        require('./pages/shared/floatFormatters'),
        require('./pages/instructorQuestion/instructorQuestion'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/gradebook', require('./pages/instructorGradebook/instructorGradebook'));
    app.use('/pl/course_instance/:course_instance_id/instructor/questions', require('./pages/instructorQuestions/instructorQuestions'));
    app.use('/pl/course_instance/:course_instance_id/instructor/issues', require('./pages/instructorIssues/instructorIssues'));
    app.use('/pl/course_instance/:course_instance_id/instructor/grading_job', require('./pages/instructorGradingJob/instructorGradingJob'));
    app.use('/pl/course_instance/:course_instance_id/instructor/syncs', require('./pages/courseSyncs/courseSyncs'));
    app.use('/pl/course_instance/:course_instance_id/instructor/jobSequence', require('./pages/instructorJobSequence/instructorJobSequence'));
    app.use('/pl/course_instance/:course_instance_id/instructor/loadFromDisk', require('./pages/instructorLoadFromDisk/instructorLoadFromDisk'));
    app.use('/pl/course_instance/:course_instance_id/instructor/course', require('./middlewares/authzCourseInstanceHasCourseView'));
    app.use('/pl/course_instance/:course_instance_id/instructor/course', require('./pages/courseOverview/courseOverview'));

    // clientFiles
    app.use('/pl/course_instance/:course_instance_id/instructor/clientFilesCourse', require('./pages/clientFilesCourse/clientFilesCourse'));
    app.use('/pl/course_instance/:course_instance_id/instructor/clientFilesCourseInstance', require('./pages/clientFilesCourseInstance/clientFilesCourseInstance'));
    app.use('/pl/course_instance/:course_instance_id/instructor/assessment/:assessment_id/clientFilesAssessment', [
        require('./middlewares/selectAndAuthzAssessment'),
        require('./pages/clientFilesAssessment/clientFilesAssessment'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/question/:question_id/clientFilesQuestion', [
        require('./middlewares/selectAndAuthzInstructorQuestion'),
        require('./pages/clientFilesQuestion/clientFilesQuestion'),
    ]);

    // generatedFiles
    app.use('/pl/course_instance/:course_instance_id/instructor/question/:question_id/generatedFilesQuestion', [
        require('./middlewares/selectAndAuthzInstructorQuestion'),
        require('./pages/instructorGeneratedFilesQuestion/instructorGeneratedFilesQuestion'),
    ]);

    // legacy client file paths
    app.use('/pl/course_instance/:course_instance_id/instructor/question/:question_id/file', [
        require('./middlewares/selectAndAuthzInstructorQuestion'),
        require('./pages/legacyQuestionFile/legacyQuestionFile'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instructor/question/:question_id/text', [
        require('./middlewares/selectAndAuthzInstructorQuestion'),
        require('./pages/legacyQuestionText/legacyQuestionText'),
    ]);

    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    // Student pages /////////////////////////////////////////////////////

    // Exam/Homeworks student routes are polymorphic - they have multiple handlers, each of
    // which checks the assessment type and calls next() if it's not the right type
    app.use('/pl/course_instance/:course_instance_id/assessments', [
        require('./middlewares/logPageView')('studentAssessments'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/studentAssessments/studentAssessments'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/assessment/:assessment_id', [
        require('./middlewares/selectAndAuthzAssessment'),
        require('./middlewares/logPageView')('studentAssessment'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/studentAssessmentHomework/studentAssessmentHomework'),
        require('./pages/studentAssessmentExam/studentAssessmentExam'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/assessment_instance/:assessment_instance_id', [
        require('./middlewares/selectAndAuthzAssessmentInstance'),
        require('./middlewares/logPageView')('studentAssessmentInstance'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/studentAssessmentInstanceHomework/studentAssessmentInstanceHomework'),
        require('./pages/studentAssessmentInstanceExam/studentAssessmentInstanceExam'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instance_question/:instance_question_id', [
        require('./middlewares/selectAndAuthzInstanceQuestion'),
        // don't use logPageView here, we load it inside the page so it can get the variant_id
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/studentInstanceQuestionHomework/studentInstanceQuestionHomework'),
        require('./pages/studentInstanceQuestionExam/studentInstanceQuestionExam'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/report_cheating', require('./pages/studentReportCheating/studentReportCheating'));
    if (config.devMode) {
        app.use('/pl/course_instance/:course_instance_id/loadFromDisk', require('./pages/instructorLoadFromDisk/instructorLoadFromDisk'));
        app.use('/pl/course_instance/:course_instance_id/jobSequence', require('./middlewares/authzCourseInstanceAuthnHasInstructorView'));
        app.use('/pl/course_instance/:course_instance_id/jobSequence', require('./pages/instructorJobSequence/instructorJobSequence'));
    }

    // Allow access to effectiveUser as a Student page, but only for users have authn (not authz) as Instructor
    app.use('/pl/course_instance/:course_instance_id/effectiveUser', require('./middlewares/authzCourseInstanceAuthnHasInstructorView'));
    app.use('/pl/course_instance/:course_instance_id/effectiveUser', require('./pages/instructorEffectiveUser/instructorEffectiveUser'));

    // clientFiles
    app.use('/pl/course_instance/:course_instance_id/clientFilesCourse', [
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/clientFilesCourse/clientFilesCourse'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/clientFilesCourseInstance', [
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/clientFilesCourseInstance/clientFilesCourseInstance'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/assessment/:assessment_id/clientFilesAssessment', [
        require('./middlewares/selectAndAuthzAssessment'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/clientFilesAssessment/clientFilesAssessment'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instance_question/:instance_question_id/clientFilesQuestion', [
        require('./middlewares/selectAndAuthzInstanceQuestion'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/clientFilesQuestion/clientFilesQuestion'),
    ]);

    // generatedFiles
    app.use('/pl/course_instance/:course_instance_id/instance_question/:instance_question_id/generatedFilesQuestion', [
        require('./middlewares/selectAndAuthzInstanceQuestion'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/studentGeneratedFilesQuestion/studentGeneratedFilesQuestion'),
    ]);

    // legacy client file paths
    app.use('/pl/course_instance/:course_instance_id/instance_question/:instance_question_id/file', [
        require('./middlewares/selectAndAuthzInstanceQuestion'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/legacyQuestionFile/legacyQuestionFile'),
    ]);
    app.use('/pl/course_instance/:course_instance_id/instance_question/:instance_question_id/text', [
        require('./middlewares/selectAndAuthzInstanceQuestion'),
        require('./middlewares/studentAssessmentAccess'),
        require('./pages/legacyQuestionText/legacyQuestionText'),
    ]);

    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    // Course pages //////////////////////////////////////////////////////

    app.use('/pl/course/:course_id', require('./middlewares/authzCourse')); // set res.locals.course
    app.use('/pl/course/:course_id', function(req, res, next) {res.locals.urlPrefix = '/pl/course/' + req.params.course_id; next();});
    app.use('/pl/course/:course_id', function(req, res, next) {res.locals.navbarType = 'course'; next();});
    app.use(/^\/pl\/course\/[0-9]+\/?$/, function(req, res, _next) {res.redirect(res.locals.urlPrefix + '/overview');}); // redirect plain course URL to overview page
    app.use('/pl/course/:course_id/overview', require('./pages/courseOverview/courseOverview'));
    app.use('/pl/course/:course_id/loadFromDisk', require('./pages/instructorLoadFromDisk/instructorLoadFromDisk'));
    app.use('/pl/course/:course_id/syncs', require('./pages/courseSyncs/courseSyncs'));
    app.use('/pl/course/:course_id/jobSequence', require('./pages/instructorJobSequence/instructorJobSequence'));

    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    // Administrator pages ///////////////////////////////////////////////

    app.use('/pl/administrator', require('./middlewares/authzIsAdministrator'));
    app.use('/pl/administrator/overview', require('./pages/administratorOverview/administratorOverview'));

    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    // Webhooks //////////////////////////////////////////////////////////
    app.get('/pl/webhooks/ping', function(req, res, _next) {res.send('.');});
    app.use('/pl/webhooks/grading', require('./webhooks/grading/grading'));

    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    //////////////////////////////////////////////////////////////////////
    // Error handling ////////////////////////////////////////////////////

    app.use(require('./middlewares/notFound')); // if no earlier routes matched, this will match and generate a 404 error
    app.use(require('./pages/error/error'));
};
