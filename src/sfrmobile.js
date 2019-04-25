const moment = require('moment')
const bluebird = require('bluebird')
const cheerio = require('cheerio')
const { log } = require('cozy-konnector-libs')

module.exports = function parseMobileBills($) {
  const result = []
  moment.locale('fr')
  const baseURL = 'https://espace-client.sfr.fr'

  // handle the special case of the first bill
  const $firstBill = $('.sr-container-wrapper-m').eq(0)
  const firstBillUrl = $firstBill.find('#lien-telecharger-pdf').attr('href')

  if (firstBillUrl) {
    const fields = $firstBill
      .find('.sr-container-content')
      .eq(0)
      .find('span:not(.sr-text-grey-14)')
    const firstBillDate = moment(fields.eq(0).text(), 'DD MMMM YYYY')
    const price = fields
      .eq(1)
      .text()
      .replace('€', '')
      .replace(',', '.')

    const bill = {
      date: firstBillDate.toDate(),
      amount: parseFloat(price),
      fileurl: `${baseURL}${firstBillUrl}`
    }

    result.push(bill)
  } else {
    log('info', 'wrong url for first PDF bill.')
  }

  let trs = Array.from($('table.sr-multi-payment tbody tr'))

  function getMoreBills() {
    // find some more rows if any
    return this.request(`${baseURL}/facture-mobile/consultation/plusDeFactures`)
      .then($ => $('tr'))
      .then($trs => {
        if ($trs.length > trs.length) {
          trs = Array.from($trs)
          return getMoreBills.bind(this)()
        } else return Promise.resolve()
      })
  }

  return getMoreBills
    .bind(this)()
    .then(() => {
      return bluebird
        .mapSeries(trs, tr => {
          let link = $(tr)
            .find('td')
            .eq(1)
            .find('a')
          if (link.length === 1) {
            link = baseURL + link.attr('href')
            return this.request(link).then($ =>
              $('.sr-container-wrapper-m')
                .eq(0)
                .html()
            )
          } else {
            return false
          }
        })
        .then(list => list.filter(item => item))
        .then(list =>
          list.map(item => {
            const $ = cheerio.load(item)
            const fileurl = $('#lien-duplicata-pdf-').attr('href')
            const fields = $('.sr-container-content')
              .eq(0)
              .find('span:not(.sr-text-grey-14)')
            const date = moment(
              fields
                .eq(0)
                .text()
                .trim(),
              'DD MMMM YYYY'
            )
            const price = fields
              .eq(1)
              .text()
              .trim()
              .replace('€', '')
              .replace(',', '.')
            if (price) {
              const bill = {
                date: date.toDate(),
                amount: parseFloat(price),
                fileurl: `${baseURL}${fileurl}`
              }
              return bill
            } else return null
          })
        )
        .then(list => list.filter(item => item))
        .then(bills => {
          if (result.length) bills.unshift(result[0])
          return bills
        })
    })
}
