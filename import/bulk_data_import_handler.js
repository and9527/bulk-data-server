const router      = require("express").Router({ mergeParams: true });
const config      = require("../config");
const bodyParser  = require("body-parser");
const Lib         = require("../lib");
const outcomes    = require("../outcomes");
const DownloadTaskCollection   = require("./DownloadTaskCollection");
const TaskManager    = require("./TaskManager");

const rateLimit = () => {

    const history = {};

    return function(req, res, next)
    {
        const ip  = req.ip;
        const now = Date.now();

        let rec = history[ip];
        if (!rec) {
            rec = history[ip] = {
                requests: 1,
                requestsPerMinute: 1,
                firstRequestAt: now
            };
        } else {
            
            const diff = (now - rec.firstRequestAt) / 60000;

            // If the last request was more than one minute ago, reset to
            // initial values and don't care about limits
            if (diff > 1) {
                rec.requests = 1;
                rec.requestsPerMinute = 1;
                rec.firstRequestAt = now;
                rec.violatedAt = 0;
            } else {
                rec.requestsPerMinute += 1;    
            }
        }

        // Servers SHOULD keep an accounting of status queries received from a
        // given client, and if a client is polling too frequently, the server
        // SHOULD respond with a 429 Too Many Requests status code in addition
        // to a Retry-After header, and optionally a FHIR OperationOutcome
        // resource with further explanation.
        if (rec.requestsPerMinute > config.maxRequestsPerMinute) {

            if (!rec.violatedAt) {
                rec.violatedAt = now;
            }

            // If excessively frequent status queries persist, the server MAY
            // return a 429 Too Many Requests status code and terminate the
            // session. Other standard HTTP 4XX as well as 5XX status codes may
            // be used to identify errors as mentioned.
            const violationDiff = (now - rec.violatedAt) / 1000;
            if (violationDiff > config.maxViolationDuration) {
                const taskId = req.params.taskId;
                if (taskId) {
                    TaskManager.remove(taskId);
                }
                return Lib.operationOutcome(res, 'Too many requests. Import aborted!', { httpCode: 429 });
            }


            const delay = Math.ceil((now - rec.firstRequestAt) / 1000);
            res.setHeader("Retry-After", delay);
            return Lib.operationOutcome(res, `Too many requests. Please try again in ${delay} seconds.`, { httpCode: 429 });
        }

        next();
    };
}


// Return import progress by task id generated during kick-off request
// and provide time interval for client to wait before checking again
router.get("/status/:taskId", rateLimit(), (req, res) => {
    const taskId = req.params.taskId;    
    const task = TaskManager.get(taskId);

    if (!task) {
        res.status(404);
        res.write("Error: requested bulk import task not found\n");
        res.end();
        return;
    }

    // task exists; check its progress

    // Task(s) finished
    // response includes successful imports and errors
    // as two arrays of OperationOutcomes
    let progress = task.progress
    if (progress >= 1) {
        const firstCompletedAt = Math.min(...task.tasks.map(t => t.endTime));
        res.setHeader("Expires", new Date(firstCompletedAt + config.dbMaintenanceMaxRecordAge * 1000).toUTCString());
        res.status(200);
        res.json(task.toJSON())
        res.end();
        return;
    }

    // task is in progress or still starting
    res.status(202);

    // set retry time based on task projected remaining time
    // but restrict max and min values to a reasonable range
    let delay;
    const remainingTime = task.remainingTime;
    const minDelay = 1 / (config.maxRequestsPerMinute / 60000);
    const maxDelay = minDelay * 2;
    if (remainingTime == -1) {
        delay = minDelay;
    } else {
        delay = Math.max(Math.min(task.remainingTime / 10, maxDelay), minDelay);
    }
    res.setHeader("retry-after", Math.ceil(delay));
    res.setHeader("x-progress", progress*100 + "%");
    res.write("bulk data import in progress / retry interval: "+delay);
    res.end();
});

// Stop an import that has not completed
router.delete("/status/:taskId", (req, res) => {
    const taskId = req.params.taskId;
    if (TaskManager.remove(taskId)) {
        return outcomes.cancelAccepted(res);
    } else {
        return outcomes.cancelNotFound(res);
    }
});

router.post("/\\$import", [
    // Prefer: respond-async (fixed value, required)
    Lib.requireRespondAsyncHeader,
    // Accept: application/fhir+json (fixed value, required)
    Lib.requireFhirJsonAcceptHeader,
    (req, res, next) => {
        // Content-Type: application/json (fixed value, required)
        if (req.headers["content-type"] != "application/json") {
            return outcomes.requireJsonContentType(res);
        }
        next();
    },
    bodyParser.json(),
    (req, res, next) => {
        const {
            // inputFormat (string, required)
            // Servers SHALL support Newline Delimited JSON with a format type
            // of application/fhir+ndjson but MAY choose to support additional
            // input formats.
            inputFormat,

            // inputSource (url, required)
            // FHIR base URL for data source. Used by the importing system when
            // matching references to previously imported data.
            inputSource = "https",

            // storageDetail (object, optional)
            // Defaults to type of “https” with no parameters specified
            storageDetail,

            // input (json array, required)
            // array of objects containing the following fields
            input = []

        } = req.body;

        // inputFormat is required
        if (!inputFormat) {
            return Lib.operationOutcome(res, 'The “inputFormat” JSON parameter is required', { httpCode: 400 });
        }
        // inputFormat must be a string
        if (typeof inputFormat != "string") {
            return Lib.operationOutcome(res, 'The “inputFormat” JSON parameter must be a string', { httpCode: 400 });
        }
        // inputSource is required
        if (!inputSource) {
            return Lib.operationOutcome(res, 'The “inputSource” JSON parameter is required', { httpCode: 400 });
        }
        // inputSource must be a string
        if (typeof inputSource != "string") {
            return Lib.operationOutcome(res, 'The “inputSource” JSON parameter must be a string', { httpCode: 400 });
        }
        // inputSource must be an URL
        if (!inputSource.match(/^\s*https?\:\/\//i)) {
            return Lib.operationOutcome(res, 'The “inputSource” JSON parameter must be an URL', { httpCode: 400 });
        }

        // if no storageDetail, it defaults to https
        // if storageDetail is provided,
        // possible types are [https, aws-s3, gcp-bucket, azure-blob]

        // validate the request conforms to spec
        
        // support ndjson files
        // inputFormat of application/fhir+ndjson
        // (optionally support other types)
        // reject with Error Code: [500 400 406 415 418]?
        // 415 seems to describe this scenario:
        // The HTTP 415 Unsupported Media Type client error response code indicates 
        // that the server refuses to accept the request because the payload format 
        // is in an unsupported format
        if (inputFormat !== "application/fhir+ndjson") {
            return Lib.operationOutcome(
                res,
                `The server did not recognize the provided inputFormat ${inputFormat}. We currently only recognize Newline Delimited JSON with inputFormat "application/fhir+ndjson"`,
                { httpCode: 415 }
            )
        }

        // input must be an array of one or more { type, url } objects
        if (!Array.isArray(input) && !input.length) {
            return Lib.operationOutcome(res, "The input must be an array of one or more objects", { httpCode: 400 });
        }
        if (!input.every(o => typeof o.type === "string" && typeof o.url === "string")) {
            return Lib.operationOutcome(res, "Each “input” element must contain url and type", { httpCode: 400 });
        }

        // Check if another import is running
        const remainingTime = TaskManager.getRemainingTime();
        if (remainingTime !== 0) {
            // retry after remainingTime, or if that is unknown - after 10s
            res.setHeader("Retry-After", remainingTime < 0 ? 10 : Math.ceil(remainingTime / 1000));
            return Lib.operationOutcome(res, "Another import operation is currently running. Please try again later.", { httpCode: 429 });
        }

        const tasks = new DownloadTaskCollection(req.body);
        TaskManager.add(tasks);
        tasks.start()
        .then(() => console.log("########################  job created with id", tasks.id));

        const pollingUrl = config.baseUrl + req.baseUrl + "/status/" + tasks.id;
        res.status(202);
        res.setHeader("Content-Location", pollingUrl);
        // optional body: FHIR OperationOutcome
        return outcomes.importAccepted(res, pollingUrl)
    }
]);

module.exports = router;