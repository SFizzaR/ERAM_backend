const calculateAge = (dateOfBirth) => {
    if (!dateOfBirth) return null;  // no date provided
    const birthDate = new Date(dateOfBirth);
    if (isNaN(birthDate)) return null;  // invalid date format

    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();

    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }

    return age;
};



module.exports = { calculateAge };