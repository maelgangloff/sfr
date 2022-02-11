process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://bacf6081e84742d9b7b2bbe958df2c7f@errors.cozycloud.cc/27'

const sleep = require('util').promisify(global.setTimeout)
const {
  CookieKonnector,
  errors,
  log,
  solveCaptcha,
  mkdirp,
  utils,
  cozyClient
} = require('cozy-konnector-libs')

const models = cozyClient.new.models
const { Qualification } = models.document

const DEBUG = true

const parseMobileBills = require('./sfrmobile.js')
const parseFixeBills = require('./sfrfixe.js')
const parseRedMobileBills = require('./redmobile.js')
const parseRedBoxBills = require('./redbox.js')

const CozyBrowser = require('cozy-konnector-libs/dist/libs/CozyBrowser')
const browser = new CozyBrowser()

browser.pipeline.addHandler(function(browser, request) {
  const blacklist = [
    '/profile-stats.js'
    // '/ckcsfr.json',
    // 'loader.sfr.min.js',
    // 'footer',
    // 'header',
    // 'recaptcha/api.js',
    // 'mire-v2-script.js',
    // 'push-download-app/push-download-app-mobile.js'
  ]
  if (blacklist.some(url => request.url.includes(url))) {
    log('info', `ignore: ${request.url}`)
    return {
      status: 200,
      statusText: 'OK',
      url: request.url,
      _consume: async () => ''
    }
  }
})

class SfrConnector extends CookieKonnector {
  async testSession() {
    await this.visit('https://www.sfr.fr/mon-espace-client/')
    const result = browser.html().includes('_is_authenticated=true;')
    log('info', `Test session result : ${result.toString()}`)
    return result
  }

  async visit(url) {
    return new Promise(resolve => {
      browser.visit(url, err => {
        log('info', `zombie visit error: ${err}`)
        resolve()
      })
    })
  }

  async pressButton(sel) {
    return new Promise(resolve => {
      browser.pressButton(sel, err => {
        log('info', `zombie pressButton error: ${err}`)
        resolve()
      })
    })
  }

  async reload() {
    return new Promise(resolve => {
      browser.reload(err => {
        log('info', `zombie reload error: ${err}`)
        resolve()
      })
    })
  }

  async authenticate(fields) {
    await this.visit('https://www.sfr.fr/cas/login')
    await sleep(5000)
    await this.reload()

    const $recaptcha = browser.query('.g-recaptcha')
    if ($recaptcha) {
      const websiteKey = browser
        .query('.g-recaptcha')
        .getAttribute('data-sitekey')

      const recaptchaResponse = await solveCaptcha({
        websiteKey,
        websiteURL: 'https://www.sfr.fr/cas/login'
      })

      await browser.evaluate(
        `$('#f-code').html('<input name="g-recaptcha-response" value="${recaptchaResponse}">')`
      )
    }

    browser.fill('#username', fields.login)
    browser.fill('#password', fields.password)
    browser.check('#remember-me')

    log('info', 'sending form')
    await this.pressButton(`#identifier`)
    log('info', 'after sending form')

    log('info', await browser.text('#E'))
    await this.visit('https://www.sfr.fr/routage/consulter-facture')

    await this.saveSession(browser)
  }

  async fetch(fields) {
    browser.loadCookieJar(this._jar._jar)
    if (!(await this.testSession())) {
      await this.testLogin(fields)
      await this.authenticate(fields)
    }

    this.request = this.requestFactory({
      cheerio: true,
      json: false,
      debug: DEBUG,
      headers: {}
    })

    const $ = await this.request('https://www.sfr.fr/mon-espace-client/')
    await this.saveSession()
    this.currentContract = $('#eTtN > div#L')
      .text()
      .trim()
      .split(' ')
      .join('')
    if (this.currentContract.includes('RÉSILIÉE')) {
      log('warn', `Found a terminated contract`)
      log('info', this.currentContract)
      return
    }
    const entries = await this.fetchBillsAttempts()
    browser.destroy()
    const folderPath = `${fields.folderPath}/${
      this.currentContract
    } ${this.contractType.toUpperCase()}`
    await mkdirp(folderPath)
    const bills = entries.map(doc => ({
      ...doc,
      vendor: 'SFR',
      recurrence: 'monthly',
      currency: '€',
      contract: this.currentContract,
      filename: `${utils.formatDate(doc.date)}_SFR_${doc.amount.toFixed(
        2
      )}€.pdf`,
      fileAttributes: {
        metadata: {
          contentAuthor: 'srf.fr',
          issueDate: utils.formatDate(doc.date),
          datetime: new Date(),
          datetimeLabel: `issueDate`,
          isSubscription: true,
          carbonCopy: true,
          qualification: Qualification.getByLabel('isp_invoice')
        }
      }
    }))
    return await this.saveBills(
      bills,
      { folderPath },
      {
        linkBankOperations: false,
        fileIdAttributes: ['date', 'amount', 'contract'],
        keys: ['date', 'amount', 'contract', 'vendor']
      }
    )
  }

  async testLogin(fields) {
    this.requestJson = this.requestFactory({
      cheerio: false,
      json: true,
      debug: DEBUG
    })
    let token
    try {
      let { createToken } = await this.requestJson(
        'https://www.sfr.fr/cas/services/rest/1.0/createToken.json?duration=8640',
        {
          auth: {
            user: fields.login,
            password: fields.password
          }
        }
      )
      token = createToken.token
    } catch (err) {
      log('error', err.message)
      throw new Error(errors.LOGIN_FAILED)
    }

    const compte = await this.requestJson(
      'https://www.sfr.fr/webservices/userprofile/rest/moncompte/' + Date.now(),
      {
        headers: {
          casauthenticationtoken: token
        }
      }
    )

    this.sfrAccount = compte.ficheMonCompte

    // detect red accounts
    const key =
      getLoginType.bind(this)(fields.login) === 'mobile'
        ? 'lignesMobiles'
        : 'lignesFixes'
    if (this.sfrAccount[key][0].profilPSW.includes('RED')) {
      log(
        'info',
        `RED account detected type: ${this.sfrAccount[key][0].profilPSW}`
      )
    }
  }

  async logIn(form, fields, $) {
    const submitForm = {
      ...form,
      username: fields.login,
      password: fields.password,
      'remember-me': 'on'
    }

    if ($('.g-recaptcha').length) {
      const websiteKey = $('.g-recaptcha').data('sitekey')
      if (websiteKey)
        submitForm['g-recaptcha-response'] = await solveCaptcha({
          websiteKey,
          websiteURL: 'https://www.sfr.fr/cas/login'
        })
      else {
        log('error', 'could not find a web site key')
        throw new Error('VENDOR_DOWN')
      }
    }

    const login$ = await this.request({
      method: 'POST',
      url:
        'https://www.sfr.fr/cas/login?domain=mire-sfr&service=https%3A%2F%2Fwww.sfr.fr%2Fj_spring_cas_security_check#sfrclicid=EC_mire_Me-Connecter',
      form: submitForm
    })

    if (login$('#loginForm').length) {
      log('error', 'html form login failed after success in api login')
      throw new Error(errors.VENDOR_DOWN)
    }
  }

  async getConsulterFacturesWithoutRedirectionError() {
    let redirCount = 0
    let response
    try {
      response = await this.request({
        url: 'https://www.sfr.fr/routage/consulter-facture',
        resolveWithFullResponse: true,
        followAllRedirects: false,
        // maxRedirects: 50,
        followOriginalHttpMethod: true,
        followRedirect: resp => {
          redirCount++
          response = resp
          const result = redirCount < 50
          return result
        }
      })
    } catch (err) {
      log('info', `Ignoring redirect error ${err.message}`)
    }

    return response
  }

  async getForm() {
    log('info', 'Logging in on Sfr Website...')
    const $ = await this.request('https://www.sfr.fr/cas/login')

    return { form: getFormData($('#loginForm')), $ }
  }

  async fetchBillsAttempts() {
    let $
    try {
      $ = await fetchBillingInfo.bind(this)()
    } catch (err) {
      if (err.message === 'FOUND_LOGIN') {
        await this.authenticate(this.fields)
        $ = await fetchBillingInfo.bind(this)()
      } else {
        throw err
      }
    }
    if (this.contractType === 'mobile') {
      return await parseMobileBills.bind(this)($)
    } else if (this.contractType === 'internet') {
      return parseFixeBills.bind(this)($)
    } else if (this.contractType === 'redmobile') {
      return await parseRedMobileBills.bind(this)($)
    } else if (this.contractType === 'redbox') {
      return parseRedBoxBills.bind(this)($)
    }
  }
}

const connector = new SfrConnector({
  cheerio: true,
  json: false,
  debug: DEBUG,
  headers: {}
})

try {
  connector
    .run()
    .catch(err =>
      log('info', `global promise exception caught: ${err.message}`)
    )
} catch (err) {
  log('info', `global error caught: ${err.message}`)
}

function getFormData($form) {
  return $form
    .serializeArray()
    .reduce((memo, input) => ({ ...memo, [input.name]: input.value }), {})
}

async function fetchBillingInfo() {
  log('info', 'Fetching bill info')

  const response = await this.getConsulterFacturesWithoutRedirectionError()

  // check that the page was not redirected to another sfr service
  const finalPath = response.headers.location || response.request.uri.path
  log('info', finalPath, 'finalPath after fetch billing info')
  if (finalPath.includes('/facture-mobile/consultation?red=1')) {
    this.contractType = 'redmobile'
  } else if (finalPath.includes('/facture-fixe/consultation?red=1')) {
    this.contractType = 'redbox'
  } else if (finalPath.includes('/facture-mobile/consultation')) {
    this.contractType = 'mobile'
  } else if (finalPath.includes('/facture-fixe/consultation')) {
    this.contractType = 'internet'
  } else if (finalPath.includes('/cas/login')) {
    throw new Error('FOUND_LOGIN')
  } else {
    throw new Error('Unknown SFR contract type')
  }
  const finalHostname = response.request.uri.hostname
  log('info', finalHostname, 'finalHostname after fetch billing info')
  // sfr : espace-client.sfr.fr
  // red : espace-client-red.sfr.fr
  // numericable : ?
  return response.body
}

function getLoginType(login) {
  if (
    this.sfrAccount.lignesMobiles.length > 0 &&
    this.sfrAccount.lignesFixes.length === 0
  ) {
    return 'mobile'
  } else if (
    this.sfrAccount.lignesFixes.length > 0 &&
    this.sfrAccount.lignesMobiles.length === 0
  ) {
    return 'internet'
  } else if (
    this.sfrAccount.lignesFixes.length === 0 &&
    this.sfrAccount.lignesMobiles.length === 0
  ) {
    log('error', 'both line types are empty')
    throw new Error(errors.USER_ACTION_NEEDED_ACCOUNT_REMOVED)
  } else if (login.match(/^\d{10}$/)) {
    return 'mobile'
  } else {
    return 'internet'
  }
}
