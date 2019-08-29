process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://896462846d0e40d0b1522d98ab103133@sentry.cozycloud.cc/118'

const {
  CookieKonnector,
  errors,
  log,
  solveCaptcha,
  retry,
  mkdirp,
  utils
} = require('cozy-konnector-libs')

const DEBUG = false

const parseMobileBills = require('./sfrmobile.js')
const parseFixeBills = require('./sfrfixe.js')
const parseRedMobileBills = require('./redmobile.js')
const parseRedBoxBills = require('./redbox.js')

class SfrConnector extends CookieKonnector {
  async fetch(fields) {
    if (!(await this.testSession())) {
      await this.testLogin(fields)
      const { form, $ } = await retry(this.getForm, {
        interval: 5000,
        throw_original: true,
        context: this
      })

      await this.logIn(form, fields, $)
      await this.saveSession()
    }

    // // trying to change contract
    // this.request = this.requestFactory({
    //   cheerio: false,
    //   json: false,
    //   debug: DEBUG,
    //   headers: {}
    // })
    // const rmehcookie = this._jar
    //   .getCookies('https://sfr.fr/')
    //   .find(cookie => cookie.key === 'rmeh').value
    // const body = await this.request(
    //   `https://www.sfr.fr/fragments/profile-stats.js?u=${rmehcookie}#`
    // )

    // const contracts = JSON.parse(
    //   body.match(/_.LL=(\[.*\]);/)[1].replace(/'/g, '"')
    // )
    // console.log(contracts)

    // console.log(contracts[1].split(':'))
    // const code = contracts[1].split(':')[2]
    // console.log(code, 'code')

    // await this.request(`https://www.red-by-sfr.fr/eTagP/ck.jsp?MLS~${code}~99`)

    // this.request = this.requestFactory({
    //   cheerio: true,
    //   json: false,
    //   debug: DEBUG,
    //   headers: {}
    // })

    // this._jar.setCookie(
    //   this.request.cookie(`MLS=${code}`),
    //   'https://www.sfr.fr/'
    // )
    // console.log(this._jar)
    // const $ = await this.request(
    //   `https://www.sfr.fr/mon-espace-client/?e=${code}#sfrclicid=EC_Home_Selecteur`
    // )

    // get current contract
    const $ = await this.request('https://www.sfr.fr/mon-espace-client/')
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

    const entries = await retry(this.fetchBillsAttempts, {
      interval: 5000,
      throw_original: true,
      // do not retry if we get the LOGIN_FAILED error code
      predicate: err => err.message !== 'LOGIN_FAILED',
      context: this
    })

    const folderPath = `${fields.folderPath}/${
      this.currentContract
    } ${this.contractType.toUpperCase()}`
    await mkdirp(folderPath)

    const bills = entries.map(doc => ({
      ...doc,
      vendor: 'SFR',
      currency: '€',
      contract: this.currentContract,
      filename: `${utils.formatDate(doc.date)}_SFR_${doc.amount.toFixed(
        2
      )}€.pdf`
    }))

    return this.saveBills(bills, folderPath, {
      identifiers: ['sfr']
    })
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
      submitForm['g-recaptcha-response'] = await solveCaptcha({
        websiteKey: $('.g-recaptcha').data('sitekey'),
        websiteURL: 'https://www.sfr.fr/cas/login'
      })
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

  async testSession() {
    const $ = await this.request('https://www.sfr.fr/routage/consulter-facture')
    return $('#loginForm').length === 0
  }

  async getForm() {
    log('info', 'Logging in on Sfr Website...')
    const $ = await this.request('https://www.sfr.fr/cas/login')

    return { form: getFormData($('#loginForm')), $ }
  }

  fetchBillsAttempts() {
    return fetchBillingInfo
      .bind(this)()
      .then($ => {
        if (this.contractType === 'mobile') {
          return parseMobileBills.bind(this)($)
        } else if (this.contractType === 'internet') {
          return parseFixeBills.bind(this)($)
        } else if (this.contractType === 'redmobile') {
          return parseRedMobileBills.bind(this)($)
        } else if (this.contractType === 'redbox') {
          return parseRedBoxBills.bind(this)($)
        }
      })
  }
}

const connector = new SfrConnector({
  cheerio: true,
  json: false,
  debug: DEBUG,
  headers: {}
})

connector.run()

function getFormData($form) {
  return $form
    .serializeArray()
    .reduce((memo, input) => ({ ...memo, [input.name]: input.value }), {})
}

function fetchBillingInfo() {
  log('info', 'Fetching bill info')
  return this.request({
    url: 'https://www.sfr.fr/routage/consulter-facture',
    resolveWithFullResponse: true
  }).then(response => {
    // check that the page was not redirected to another sfr service
    const finalPath = response.request.uri.path
    log('info', finalPath, 'finalPath after fetch billing info')
    if (finalPath === '/facture-mobile/consultation') {
      this.contractType = 'mobile'
    } else if (finalPath === '/facture-fixe/consultation') {
      this.contractType = 'internet'
    } else if (finalPath === '/facture-mobile/consultation?red=1') {
      this.contractType = 'redmobile'
    } else if (finalPath === '/facture-fixe/consultation?red=1') {
      this.contractType = 'redbox'
    } else if (finalPath.includes('/cas/login')) {
      throw new Error(errors.VENDOR_DOWN)
    } else {
      throw new Error('Unknown SFR contract type')
    }
    const finalHostname = response.request.uri.hostname
    log('info', finalHostname, 'finalHostname after fetch billing info')
    // sfr : espace-client.sfr.fr
    // red : espace-client-red.sfr.fr
    // numericable : ?
    return response.body
  })
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
