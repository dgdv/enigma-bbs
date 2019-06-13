/* jslint node: true */
'use strict';

//  ENiGMA½
const Config                = require('./config.js').get;
const Errors                = require('./enig_error.js').Errors;
const getServer             = require('./listening_server.js').getServer;
const webServerPackageName  = require('./servers/content/web.js').moduleInfo.packageName;
const {
    createToken,
    getTokenInfo,
    WellKnownTokenTypes,
}                           = require('./user_temp_token.js');
const { sendMail }          = require('./email.js');
const UserProps             = require('./user_property.js');
const Log                   = require('./logger.js').log;

//  deps
const async                 = require('async');
const fs                    = require('fs-extra');
const _                     = require('lodash');
const url                   = require('url');
const querystring           = require('querystring');

function getWebServer() {
    return getServer(webServerPackageName);
}

const DefaultEmailTextTemplate =
    `%USERNAME%:
You have requested to enable 2-Factor Authentication via One-Time-Password
for your account on %BOARDNAME%.

    * If this was not you, please ignore this email and change your password.
    * Otherwise, please follow the link below:

    %REGISTER_URL%
`;

module.exports = class User2FA_OTPWebRegister
{
    static startup(cb) {
        return User2FA_OTPWebRegister.registerRoutes(cb);
    }

    static sendRegisterEmail(user, otpType, cb) {
        async.waterfall(
            [
                (callback) => {
                    return createToken(
                        user.userId,
                        WellKnownTokenTypes.AuthFactor2OTPRegister,
                        { bits : 128 },
                        callback
                    );
                },
                (token, callback) => {
                    const config = Config();
                    const txtTemplateFile   = _.get(config, 'users.twoFactorAuth.otp.registerEmailText');
                    const htmlTemplateFile  = _.get(config, 'users.twoFactorAuth.otp.registerEmailHtml');

                    fs.readFile(txtTemplateFile, 'utf8', (err, textTemplate) => {
                        textTemplate = textTemplate || DefaultEmailTextTemplate;
                        fs.readFile(htmlTemplateFile, 'utf8', (err, htmlTemplate) => {
                            htmlTemplate = htmlTemplate || null;    //  be explicit for waterfall
                            return callback(null, token, textTemplate, htmlTemplate);
                        });
                    });
                },
                (token, textTemplate, htmlTemplate, callback) => {
                    const webServer = getWebServer();
                    const registerUrl = webServer.instance.buildUrl(
                        `/enable_2fa_otp?token=&otpType=${otpType}&token=${token}`
                    );

                    const replaceTokens = (s) => {
                        return s
                            .replace(/%BOARDNAME%/g,    Config().general.boardName)
                            .replace(/%USERNAME%/g,     user.username)
                            .replace(/%TOKEN%/g,        token)
                            .replace(/%REGISTER_URL%/g, registerUrl)
                        ;
                    };

                    textTemplate = replaceTokens(textTemplate);
                    if(htmlTemplate) {
                        htmlTemplate = replaceTokens(htmlTemplate);
                    }

                    const message = {
                        to      : `${user.getProperty(UserProps.RealName) || user.username} <${user.getProperty(UserProps.EmailAddress)}>`,
                        //  from will be filled in
                        subject : '2-Factor Authentication Registration',
                        text    : textTemplate,
                        html    : htmlTemplate,
                    };

                    sendMail(message, (err, info) => {
                        if(err) {
                            Log.warn({ error : err.message }, 'Failed sending 2FA/OTP register email');
                        } else {
                            Log.info( { info }, 'Successfully sent 2FA/OTP register email');
                        }
                        return callback(err);
                    });
                }
            ],
            err => {
                return cb(err);
            }
        );
    }

    static fileNotFound(webServer, resp) {
        return webServer.instance.fileNotFound(resp);
    }

    static accessDenied(webServer, resp) {
        return webServer.instance.accessDenied(resp);
    }

    static routeRegisterGet(req, resp) {
        const webServer = getWebServer();   //  must be valid, we just got a req!

        const urlParts  = url.parse(req.url, true);
        const token     = urlParts.query && urlParts.query.token;
        const otpType   = urlParts.query && urlParts.query.otpType;

        if(!token || !otpType) {
            return User2FA_OTPWebRegister.accessDenied(webServer, resp);
        }

        getTokenInfo(token, (err, tokenInfo) => {
            if(err) {
                //  assume expired
                return webServer.instance.respondWithError(resp, 410, 'Invalid or expired registration link.', 'Expired Link');
            }

            if(tokenInfo.tokenType !== 'auth_factor2_otp_register') {
                return User2FA_OTPWebRegister.accessDenied(webServer, resp);
            }

            const qrImg = '';   //  :TODO: fix me
            const secret = '';
            const backupCodes = '';

            const postUrl = webServer.instance.buildUrl('/enable_2fa_otp');
            const config = Config();
            return webServer.instance.routeTemplateFilePage(
                _.get(config, 'users.twoFactorAuth.otp.registerPageTemplate'),
                (templateData, next) => {
                    const finalPage = templateData
                        .replace(/%BOARDNAME%/g,    config.general.boardName)
                        .replace(/%USERNAME%/g,     tokenInfo.user.username)
                        .replace(/%TOKEN%/g,        token)
                        .replace(/%OTP_TYPE%/g,     otpType)
                        .replace(/%POST_URL%/g,     postUrl)
                        .replace(/%QR_IMG%/g,       qrImg)
                        .replace(/%SECRET%/g,       secret)
                        .replace(/%BACKUP_CODES%/g, backupCodes)
                    ;
                    return next(null, finalPage);
                },
                resp
            );
        });
    }

    static routeRegisterPost(req, resp) {
        const webServer = getWebServer();   //  must be valid, we just got a req!

        const badRequest = () => {
            return webServer.instance.respondWithError(resp, 400, 'Bad Request.', 'Bad Request');
        };

        let bodyData = '';
        req.on('data', data => {
            bodyData += data;
        });

        req.on('end', () => {
            const formData = querystring.parse(bodyData);

            const config = Config();
            if(!formData.token || !formData.otpType || !formData.otp) {
                return badRequest();
            }
        });

        return webServer.instance.respondWithError(resp, 410, 'Invalid or expired registration link.', 'Expired Link');
    }

    static registerRoutes(cb) {
        const webServer = getWebServer();
        if(!webServer || !webServer.instance.isEnabled()) {
            return cb(null);    //  no webserver enabled
        }

        [
            {
                method  : 'GET',
                path    : '^\\/enable_2fa_otp\\?token\\=[a-f0-9]+&otpType\\=[a-zA-Z0-9]+$',
                handler : User2FA_OTPWebRegister.routeRegisterGet,
            },
            {
                method  : 'POST',
                path    : '^\\/enable_2fa_otp$',
                handler : User2FA_OTPWebRegister.routeRegisterPost,
            }
        ].forEach(r => {
            webServer.instance.addRoute(r);
        });

        return cb(null);
    }
};